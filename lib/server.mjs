import path from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "markdownlint/promise";
import {
	CodeAction,
	CodeActionKind,
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	DidChangeWatchedFilesNotification,
	PositionEncodingKind,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextEdit,
	TraceValues,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON,
	loadConfig,
} from "./config.mjs";

const DEFAULT_VALIDATION_DELAY_MS = 200;
const CONFIG_CHANGE_DEBOUNCE_MS = 300;

export class Server {
	#connection;
	#documents = new Map();
	#config = {
		default: true,
	};
	#trace = TraceValues.Off;
	#validationDelay = DEFAULT_VALIDATION_DELAY_MS;
	#rootPath = null;
	#workspaceFolders = [];
	#initializationOptions = {};
	#hasDidChangeWatchedFilesCapability = false;
	#hasWorkspaceFoldersCapability = false;
	#validationTimeouts = new Map();
	#documentFixes = new Map();
	#latestVersionByUri = new Map();
	#configCache = new Map();
	#configChangeTimeout = null;

	constructor() {
		this.#connection = createConnection(ProposedFeatures.all);
		this.setupEventHandlers();
	}

	setupEventHandlers() {
		this.#connection.onInitialize(async (params) => {
			this.#logTrace("Initializing server...");

			this.#hasDidChangeWatchedFilesCapability =
				params.capabilities.workspace?.didChangeWatchedFiles
					?.dynamicRegistration ?? false;

			this.#hasWorkspaceFoldersCapability =
				params.capabilities.workspace?.workspaceFolders?.supported ?? false;

			if (params.trace) {
				this.#trace = params.trace;
			}

			this.#workspaceFolders = params.workspaceFolders ?? [];
			this.#rootPath = this.#chooseRootPath(
				params.rootPath,
				params.rootUri,
				this.#workspaceFolders,
			);

			this.#initializationOptions = params.initializationOptions || {};
			this.#config = this.#initializationOptions.config || {};
			if (
				typeof this.#initializationOptions.validationDelay === "number" &&
				Number.isFinite(this.#initializationOptions.validationDelay)
			) {
				this.#validationDelay = Math.max(
					0,
					this.#initializationOptions.validationDelay,
				);
			}

			this.#logTrace(
				`Initial server configuration: ${JSON.stringify(this.#config)}`,
			);

			return {
				capabilities: {
					textDocumentSync: TextDocumentSyncKind.Incremental,
					positionEncoding: PositionEncodingKind.UTF16,
					codeActionProvider: {
						codeActionKinds: [CodeActionKind.QuickFix],
					},
					workspace: {
						workspaceFolders: {
							supported: true,
							changeNotifications: true,
						},
					},
				},
			};
		});

		this.#connection.onInitialized(() => {
			this.#logTrace("Server initialized.");
			if (this.#hasDidChangeWatchedFilesCapability) {
				this.#connection.client.register(
					DidChangeWatchedFilesNotification.type,
					{
						watchers: [
							...ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON.map((pattern) => ({
								globPattern: `**/${pattern}`,
							})),
							{
								globPattern: "**/package.json",
							},
						],
					},
				);
			}
			if (this.#hasWorkspaceFoldersCapability) {
				this.setupWorkspaceEventHandlers();
			}
		});

		this.#connection.onDidChangeWatchedFiles(async () => {
			if (this.#configChangeTimeout) {
				clearTimeout(this.#configChangeTimeout);
			}
			this.#configChangeTimeout = setTimeout(() => {
				this.#logTrace(
					"Configuration file changed. Clearing config cache and re-validating all documents.",
				);
				this.#configCache.clear();
				for (const document of this.#documents.values()) {
					this.validateDocument(document);
				}
				this.#configChangeTimeout = null;
			}, CONFIG_CHANGE_DEBOUNCE_MS);
		});

		this.#connection.onDidOpenTextDocument((params) => {
			const document = TextDocument.create(
				params.textDocument.uri,
				params.textDocument.languageId,
				params.textDocument.version,
				params.textDocument.text,
			);
			this.#documents.set(params.textDocument.uri, document);
			this.#logTrace(`Document opened: ${params.textDocument.uri}`);
			this.throttledValidateDocument(document);
		});

		this.#connection.onDidChangeTextDocument((params) => {
			const document = this.#documents.get(params.textDocument.uri);
			if (document) {
				const updatedDocument = TextDocument.update(
					document,
					params.contentChanges,
					params.textDocument.version,
				);
				this.#documents.set(params.textDocument.uri, updatedDocument);
				this.#logTrace(
					`Document changed: ${params.textDocument.uri} v${params.textDocument.version}`,
				);
				this.throttledValidateDocument(updatedDocument);
			}
		});

		this.#connection.onDidSaveTextDocument((params) => {
			this.#logTrace(`Document saved: ${params.textDocument.uri}`);
			const document = this.#documents.get(params.textDocument.uri);
			if (document) {
				if (this.#validationTimeouts.has(params.textDocument.uri)) {
					clearTimeout(this.#validationTimeouts.get(params.textDocument.uri));
					this.#validationTimeouts.delete(params.textDocument.uri);
				}
				this.validateDocument(document);
			}
		});

		this.#connection.onDidCloseTextDocument((params) => {
			this.#documents.delete(params.textDocument.uri);
			this.#documentFixes.delete(params.textDocument.uri);
			this.#latestVersionByUri.delete(params.textDocument.uri);

			if (this.#validationTimeouts.has(params.textDocument.uri)) {
				clearTimeout(this.#validationTimeouts.get(params.textDocument.uri));
				this.#validationTimeouts.delete(params.textDocument.uri);
			}

			const workspaceRoot = this.#getWorkspaceRootFor(params.textDocument.uri);
			const cacheKey = `${workspaceRoot}:${params.textDocument.uri}`;
			this.#configCache.delete(cacheKey);

			this.#connection.sendDiagnostics({
				uri: params.textDocument.uri,
				diagnostics: [],
			});
			this.#logTrace(`Document closed: ${params.textDocument.uri}`);
		});

		this.#connection.onDidChangeConfiguration(async () => {
			this.#logTrace(
				"Configuration changed. Clearing config cache and re-validating all documents.",
			);
			this.#configCache.clear();
			try {
				const settings =
					await this.#connection.workspace.getConfiguration("markdownlint");
				const initializationConfig = this.#initializationOptions?.config ?? {};
				const resolvedSettings = settings ?? {};
				this.#config = {
					...initializationConfig,
					...resolvedSettings,
				};
				this.#logTrace(
					`New server configuration: ${JSON.stringify(this.#config)}`,
				);
				for (const document of this.#documents.values()) {
					this.validateDocument(document);
				}
			} catch (error) {
				this.#logTrace(`Error fetching configuration: ${error}`);
			}
		});

		this.#connection.onCodeAction((params) => {
			const uri = params.textDocument.uri;
			const document = this.#documents.get(uri);

			if (!document) {
				return [];
			}

			if (
				params.context.only &&
				!params.context.only.includes(CodeActionKind.QuickFix) &&
				!params.context.only.some((kind) =>
					CodeActionKind.QuickFix.startsWith(`${kind}.`),
				)
			) {
				return [];
			}

			const diagnosticFixPairs = this.#documentFixes.get(uri);
			if (!diagnosticFixPairs || diagnosticFixPairs.length === 0) {
				return [];
			}

			this.#logTrace(
				`Code actions requested for ${uri} at range ${JSON.stringify(params.range)}`,
			);

			const codeActions = [];

			for (const requestedDiagnostic of params.context.diagnostics) {
				const pair = this.#findDiagnosticFixPair(
					requestedDiagnostic,
					diagnosticFixPairs,
				);

				if (!pair) {
					continue;
				}

				const textEdit = this.#fixInfoToTextEdit(
					pair.fixInfo,
					pair.diagnostic,
					document,
				);
				if (!textEdit) {
					continue;
				}

				const codeAction = CodeAction.create(
					`Fix: ${requestedDiagnostic.message}`,
					CodeActionKind.QuickFix,
				);

				codeAction.diagnostics = [requestedDiagnostic];
				codeAction.edit = {
					changes: {
						[uri]: [textEdit],
					},
				};
				codeActions.push(codeAction);
			}

			this.#logTrace(`Returning ${codeActions.length} code actions`);
			return codeActions;
		});
	}

	async validateDocument(document) {
		if (document.languageId !== "markdown") {
			this.#logTrace(`Unsupported languageId: ${document.languageId}`);
			return;
		}

		// Clear any pending throttled validation for this document
		// to prevent stale validations from firing
		const pendingTimeout = this.#validationTimeouts.get(document.uri);
		if (pendingTimeout) {
			clearTimeout(pendingTimeout);
			this.#validationTimeouts.delete(document.uri);
		}

		this.#logTrace(`Validating: ${document.uri}`);

		const currentVersion = document.version;
		this.#latestVersionByUri.set(document.uri, currentVersion);

		const workspaceRoot = this.#getWorkspaceRootFor(document.uri);
		const cacheKey = `${workspaceRoot}:${document.uri}`;

		let documentOptions = this.#configCache.get(cacheKey);
		if (!documentOptions) {
			documentOptions =
				(await loadConfig(
					document.uri,
					workspaceRoot,
					this.#logTrace.bind(this),
				)) || {};
			this.#configCache.set(cacheKey, documentOptions);
			this.#logTrace(`Cached config for ${cacheKey}`);
		} else {
			this.#logTrace(`Using cached config for ${cacheKey}`);
		}

		this.#logTrace(
			`Will validate ${document.uri} with ${JSON.stringify(documentOptions)}`,
		);

		const content = document.getText();
		const options = {
			...documentOptions,
			strings: {
				[document.uri]: content,
			},
			config: {
				...documentOptions.config,
				...this.#config,
			},
			handleRuleFailures: true,
		};

		try {
			const results = await lint(options);

			if (this.#latestVersionByUri.get(document.uri) !== currentVersion) {
				this.#logTrace(
					`Discarding stale validation result for ${document.uri} v${currentVersion}`,
				);
				return;
			}

			const issues = results[document.uri] || [];
			const diagnostics = [];
			const diagnosticFixPairs = [];

			for (const issue of issues) {
				const line = (issue.lineNumber || 1) - 1;
				const [startChar, length] = issue.errorRange
					? [(issue.errorRange[0] || 1) - 1, issue.errorRange[1]]
					: [0, 1];

				const diagnostic = Diagnostic.create(
					{
						start: { line, character: startChar },
						end: { line, character: startChar + length },
					},
					`${issue.ruleDescription} (${issue.ruleNames.join("/")})`,
					DiagnosticSeverity.Warning,
					issue.ruleNames[0],
					"markdownlint",
				);

				diagnostics.push(diagnostic);

				if (issue.fixInfo) {
					diagnosticFixPairs.push({
						diagnostic,
						fixInfo: issue.fixInfo,
					});
				}
			}

			this.#documentFixes.set(document.uri, diagnosticFixPairs);

			this.#connection.sendDiagnostics({
				uri: document.uri,
				diagnostics,
				version: currentVersion,
			});
			this.#logTrace(
				`Sent ${diagnostics.length} diagnostics (${diagnosticFixPairs.length} with fixes) for ${document.uri} v${currentVersion}`,
			);
		} catch (error) {
			this.#logTrace(`Linting error for ${document.uri}: ${error}`);
			// Clear stale diagnostics to avoid misleading users with outdated issues
			this.#connection.sendDiagnostics({
				uri: document.uri,
				diagnostics: [],
				version: currentVersion,
			});
		}
	}

	listen() {
		this.#connection.onNotification("$/setTrace", (params) => {
			this.#trace = params.value;
			this.#logTrace(`Trace level set to: ${this.#trace}`);
		});
		this.#connection.listen();
		this.#logTrace("Server listening for connections.");
	}

	#logTrace(message) {
		if (this.#trace === TraceValues.Off) {
			return;
		}
		this.#connection.sendNotification("$/logTrace", { message });
	}

	#getWorkspaceRootFor(documentUri) {
		if (!documentUri.startsWith("file:")) {
			return this.#rootPath ?? process.cwd();
		}

		let docPath;
		try {
			docPath = fileURLToPath(documentUri);
		} catch (error) {
			this.#logTrace(`Invalid file URI: ${documentUri}: ${error}`);
			return this.#rootPath ?? process.cwd();
		}

		for (const folder of this.#workspaceFolders) {
			if (folder.uri?.startsWith("file:")) {
				try {
					const folderPath = fileURLToPath(folder.uri);
					const relative = path.relative(folderPath, docPath);
					if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
						return folderPath;
					}
				} catch (error) {
					this.#logTrace(
						`Invalid workspace folder URI: ${folder.uri}: ${error}`,
					);
				}
			}
		}

		return this.#rootPath ?? process.cwd();
	}

	setupWorkspaceEventHandlers() {
		this.#connection.workspace.onDidChangeWorkspaceFolders((event) => {
			this.#logTrace("Workspace folders changed.");

			this.#workspaceFolders = this.#workspaceFolders.filter(
				(folder) =>
					!event.removed.some(
						(removedFolder) => removedFolder.uri === folder.uri,
					),
			);

			this.#workspaceFolders.push(...event.added);

			const rootPathStillPresent = this.#isPathInWorkspaceFolders(
				this.#rootPath,
			);
			if (!rootPathStillPresent) {
				this.#rootPath = this.#chooseRootPath(
					null,
					null,
					this.#workspaceFolders,
				);
			}

			this.#logTrace(
				`Updated workspace folders: ${this.#workspaceFolders.map((f) => f.uri).join(", ")}`,
			);

			this.#logTrace("Clearing config cache due to workspace folder changes.");
			this.#configCache.clear();

			for (const document of this.#documents.values()) {
				this.validateDocument(document);
			}
		});
	}

	throttledValidateDocument(document, delay = this.#validationDelay) {
		const uri = document.uri;

		if (this.#validationTimeouts.has(uri)) {
			clearTimeout(this.#validationTimeouts.get(uri));
		}

		const timeoutId = setTimeout(() => {
			this.#validationTimeouts.delete(uri);
			if (this.#documents.has(uri)) {
				this.validateDocument(document);
			}
		}, delay);

		this.#validationTimeouts.set(uri, timeoutId);
	}

	#findDiagnosticFixPair(requestedDiagnostic, diagnosticFixPairs) {
		for (const pair of diagnosticFixPairs) {
			const storedDiagnostic = pair.diagnostic;

			if (
				storedDiagnostic.range.start.line !==
				requestedDiagnostic.range.start.line
			) {
				continue;
			}

			if (
				storedDiagnostic.range.start.character !==
					requestedDiagnostic.range.start.character ||
				storedDiagnostic.range.end.character !==
					requestedDiagnostic.range.end.character
			) {
				continue;
			}

			if (storedDiagnostic.code !== requestedDiagnostic.code) {
				continue;
			}

			return pair;
		}

		return null;
	}

	#fixInfoToTextEdit(fixInfo, diagnostic, document) {
		const lineNumber = fixInfo.lineNumber
			? fixInfo.lineNumber - 1
			: diagnostic.range.start.line;

		const editColumn = (fixInfo.editColumn || 1) - 1;
		const deleteCount = fixInfo.deleteCount || 0;
		const insertText = fixInfo.insertText || "";

		if (deleteCount === 0 && insertText === "") {
			this.#logTrace("Skipping no-op edit (no delete, no insert)");
			return null;
		}

		if (lineNumber < 0 || lineNumber >= document.lineCount) {
			this.#logTrace(
				`Skipping edit: line ${lineNumber} out of bounds (document has ${document.lineCount} lines)`,
			);
			return null;
		}

		if (editColumn < 0) {
			this.#logTrace(`Skipping edit: negative column ${editColumn}`);
			return null;
		}

		const lineText = document.getText({
			start: { line: lineNumber, character: 0 },
			end: { line: lineNumber, character: Number.MAX_SAFE_INTEGER },
		});
		const lineLen = lineText.length;

		const startChar = Math.min(editColumn, lineLen);
		const endChar = Math.min(editColumn + deleteCount, lineLen);

		if (startChar === endChar && insertText === "") {
			this.#logTrace(
				`Skipping no-op edit after clamping (line ${lineNumber}, col ${startChar})`,
			);
			return null;
		}

		const startPos = { line: lineNumber, character: startChar };
		const endPos = { line: lineNumber, character: endChar };

		this.#logTrace(
			`Creating TextEdit: line ${lineNumber}, col ${startChar}-${endChar}, insert "${insertText}"`,
		);

		return TextEdit.replace(
			{
				start: startPos,
				end: endPos,
			},
			insertText,
		);
	}

	#chooseRootPath(rootPath, rootUri, workspaceFolders = []) {
		if (rootPath) {
			return rootPath;
		}

		if (rootUri?.startsWith("file:")) {
			return fileURLToPath(rootUri);
		}

		const primaryFolder = workspaceFolders.find((folder) =>
			folder.uri?.startsWith("file:"),
		);
		if (primaryFolder?.uri) {
			return fileURLToPath(primaryFolder.uri);
		}

		return null;
	}

	#isPathInWorkspaceFolders(targetPath) {
		if (!targetPath) {
			return false;
		}

		const normalizedTarget = path.normalize(targetPath);

		return this.#workspaceFolders.some((folder) => {
			if (!folder.uri?.startsWith("file:")) {
				return false;
			}
			const folderPath = fileURLToPath(folder.uri);
			return path.normalize(folderPath) === normalizedTarget;
		});
	}
}
