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
import mergeOptions from "./merge-options.mjs";

const DEFAULT_VALIDATION_DELAY_MS = 200;
const CONFIG_CHANGE_DEBOUNCE_MS = 300;
const CONFIG_CACHE_MAX_SIZE = 100;

export class Server {
	#connection;
	#documents = new Map();
	#settings = {
		config: {
			default: true,
		},
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
	#positionEncoding = PositionEncodingKind.UTF16;
	#validationInFlight = new Set();
	#queuedValidations = new Map();

	constructor() {
		this.#connection = createConnection(ProposedFeatures.all);
		this.setupEventHandlers();
	}

	setupEventHandlers() {
		this.#connection.onInitialize(async (params) => {
			this.#logTrace("Initializing server...");

			const clientPositionEncodings =
				params.capabilities.general?.positionEncodings;
			if (
				Array.isArray(clientPositionEncodings) &&
				clientPositionEncodings.length > 0
			) {
				if (clientPositionEncodings.includes(PositionEncodingKind.UTF16)) {
					this.#positionEncoding = PositionEncodingKind.UTF16;
				} else {
					this.#positionEncoding = clientPositionEncodings[0];
					this.#logTrace(
						`Client does not advertise UTF-16 support. Using ${this.#positionEncoding} while internal offsets remain UTF-16.`,
					);
				}
			}

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
			this.#settings = this.#resolveSettings(this.#initializationOptions);
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
				`Initial server configuration: ${JSON.stringify(this.#settings)}`,
			);

			return {
				capabilities: {
					textDocumentSync: TextDocumentSyncKind.Incremental,
					positionEncoding: this.#positionEncoding,
					codeActionProvider: {
						codeActionKinds: [
							CodeActionKind.QuickFix,
							CodeActionKind.SourceFixAll,
						],
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
					this.#enqueueValidation(document);
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
				const contentChanges =
					this.#positionEncoding === PositionEncodingKind.UTF16
						? params.contentChanges
						: this.#convertContentChangesToUtf16(
							params.contentChanges,
							document,
						);
				const updatedDocument = TextDocument.update(
					document,
					contentChanges,
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
				this.#enqueueValidation(document);
			}
		});

		this.#connection.onDidCloseTextDocument((params) => {
			this.#documents.delete(params.textDocument.uri);
			this.#documentFixes.delete(params.textDocument.uri);
			this.#latestVersionByUri.delete(params.textDocument.uri);
			this.#queuedValidations.delete(params.textDocument.uri);
			this.#validationInFlight.delete(params.textDocument.uri);

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
				const initializationSettings = this.#resolveSettings(
					this.#initializationOptions,
				);
				const resolvedSettings = this.#resolveSettings(settings ?? {});
				this.#settings = mergeOptions(
					initializationSettings,
					resolvedSettings,
				);
				this.#logTrace(
					`New server configuration: ${JSON.stringify(this.#settings)}`,
				);
				for (const document of this.#documents.values()) {
					this.#enqueueValidation(document);
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

			const diagnosticFixPairs = this.#documentFixes.get(uri);
			if (!diagnosticFixPairs || diagnosticFixPairs.length === 0) {
				return [];
			}

			const requestRange = this.#convertRangeToUtf16(params.range, document);
			this.#logTrace(
				`Code actions requested for ${uri} at range ${JSON.stringify(requestRange)}`,
			);

			const codeActions = [];

			// Check if we should provide Fix All action
			const shouldProvideFixAll =
				!params.context.only ||
				params.context.only.includes(CodeActionKind.SourceFixAll) ||
				params.context.only.some((kind) =>
					CodeActionKind.SourceFixAll.startsWith(`${kind}.`),
				);

			// Check if we should provide QuickFix actions
			const shouldProvideQuickFix =
				!params.context.only ||
				params.context.only.includes(CodeActionKind.QuickFix) ||
				params.context.only.some((kind) =>
					CodeActionKind.QuickFix.startsWith(`${kind}.`),
				);

			// Generate individual quick fix actions
			if (shouldProvideQuickFix) {
				const requestedDiagnostics =
					params.context.diagnostics?.length > 0
						? params.context.diagnostics.map((diagnostic) => ({
								converted: this.#convertDiagnosticToUtf16(diagnostic, document),
								original: diagnostic,
							}))
						: diagnosticFixPairs
								.filter((pair) =>
									this.#rangesOverlap(pair.diagnostic.range, requestRange),
								)
								.map((pair) => ({
										converted: pair.diagnostic,
										original: this.#convertDiagnosticFromUtf16(
											pair.diagnostic,
											document,
										),
									}));

				for (const { converted, original } of requestedDiagnostics) {
					const pair = this.#findDiagnosticFixPair(
						converted,
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
						`Fix: ${original.message}`,
						CodeActionKind.QuickFix,
					);

					codeAction.diagnostics = [original];
					codeAction.edit = {
						changes: {
							[uri]: [this.#convertTextEditFromUtf16(textEdit, document)],
						},
					};
					codeActions.push(codeAction);
				}
			}

			// Generate "Fix All" action
			if (shouldProvideFixAll && diagnosticFixPairs.length > 0) {
				const allTextEdits = [];
					for (const pair of diagnosticFixPairs) {
						const textEdit = this.#fixInfoToTextEdit(
							pair.fixInfo,
							pair.diagnostic,
							document,
						);
						if (textEdit) {
							allTextEdits.push(textEdit);
						}
					}

				if (allTextEdits.length > 0) {
					// Sort edits by position (descending) to apply from end to start
					// This prevents position shifts from affecting later edits
					allTextEdits.sort((a, b) => {
						const lineDiff = b.range.start.line - a.range.start.line;
						if (lineDiff !== 0) return lineDiff;
						return b.range.start.character - a.range.start.character;
					});

					// Remove overlapping edits (keep first in sorted order)
					const nonOverlappingEdits = [];
					for (const edit of allTextEdits) {
						const overlaps = nonOverlappingEdits.some((existing) =>
							this.#rangesOverlap(edit.range, existing.range),
						);
						if (!overlaps) {
							nonOverlappingEdits.push(edit);
						} else {
							this.#logTrace(
								`Skipping overlapping fix-all edit at ${JSON.stringify(edit.range)}`,
							);
						}
					}

						const fixAllAction = CodeAction.create(
							`Fix all auto-fixable markdownlint issues (${nonOverlappingEdits.length})`,
							CodeActionKind.SourceFixAll,
						);
						fixAllAction.edit = {
							changes: {
								[uri]: nonOverlappingEdits.map((edit) =>
									this.#convertTextEditFromUtf16(edit, document),
								),
							},
						};
					codeActions.push(fixAllAction);
				}
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

			// Implement LRU cache eviction
			if (this.#configCache.size >= CONFIG_CACHE_MAX_SIZE) {
				// Delete oldest entry (first key in Map)
				const oldestKey = this.#configCache.keys().next().value;
				this.#configCache.delete(oldestKey);
				this.#logTrace(`Evicted oldest config cache entry: ${oldestKey}`);
			}

			this.#configCache.set(cacheKey, documentOptions);
			this.#logTrace(`Cached config for ${cacheKey}`);
		} else {
			// Refresh LRU: delete and re-add to move to end
			this.#configCache.delete(cacheKey);
			this.#configCache.set(cacheKey, documentOptions);
			this.#logTrace(`Using cached config for ${cacheKey}`);
		}

		this.#logTrace(
			`Will validate ${document.uri} with ${JSON.stringify(documentOptions)}`,
		);

		const mergedOptions = mergeOptions(documentOptions, this.#settings);
		const content = document.getText();
		const options = {
			...mergedOptions,
			strings: {
				[document.uri]: content,
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

			const outgoingDiagnostics = this.#convertDiagnosticsFromUtf16(
				diagnostics,
				document,
			);
			this.#connection.sendDiagnostics({
				uri: document.uri,
				diagnostics: outgoingDiagnostics,
				version: currentVersion,
			});
			this.#logTrace(
				`Sent ${diagnostics.length} diagnostics (${diagnosticFixPairs.length} with fixes) for ${document.uri} v${currentVersion}`,
			);
		} catch (error) {
			this.#logTrace(`Linting error for ${document.uri}: ${error}`);
			// Clear stale diagnostics and fixes to avoid misleading users
			this.#documentFixes.delete(document.uri);
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
				this.#enqueueValidation(document);
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
				this.#enqueueValidation(document);
			}
		}, delay);

		this.#validationTimeouts.set(uri, timeoutId);
	}

	#enqueueValidation(document) {
		const uri = document.uri;
		if (this.#validationInFlight.has(uri)) {
			this.#queuedValidations.set(uri, document);
			return;
		}
		this.#validationInFlight.add(uri);
		this.validateDocument(document)
			.catch((error) => {
				this.#logTrace(`Validation error for ${uri}: ${error}`);
			})
			.finally(() => {
				this.#validationInFlight.delete(uri);
				const queued = this.#queuedValidations.get(uri);
				if (queued) {
					this.#queuedValidations.delete(uri);
					this.#enqueueValidation(queued);
				}
			});
	}

	#resolveSettings(settings) {
		const resolvedSettings =
			settings && typeof settings === "object" ? settings : {};
		const { validationDelay, ...options } = resolvedSettings;
		return mergeOptions(
			{
				config: {
					default: true,
				},
			},
			options,
		);
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

		if (deleteCount < 0) {
			this.#logTrace(`Skipping edit: negative deleteCount ${deleteCount}`);
			return null;
		}

		const lineText = this.#getLineText(document, lineNumber);
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

	#getLineText(document, line) {
		if (line < 0 || line >= document.lineCount) {
			return "";
		}
		return document.getText({
			start: { line, character: 0 },
			end: { line, character: Number.MAX_SAFE_INTEGER },
		});
	}

	#convertContentChangesToUtf16(contentChanges, document) {
		return contentChanges.map((change) => {
			if (!change.range) {
				return change;
			}
			return {
				...change,
				range: this.#convertRangeToUtf16(change.range, document),
			};
		});
	}

	#convertDiagnosticsFromUtf16(diagnostics, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return diagnostics;
		}
		return diagnostics.map((diagnostic) =>
			this.#convertDiagnosticFromUtf16(diagnostic, document),
		);
	}

	#convertDiagnosticFromUtf16(diagnostic, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return diagnostic;
		}
		return {
			...diagnostic,
			range: this.#convertRangeFromUtf16(diagnostic.range, document),
		};
	}

	#convertDiagnosticToUtf16(diagnostic, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return diagnostic;
		}
		return {
			...diagnostic,
			range: this.#convertRangeToUtf16(diagnostic.range, document),
		};
	}

	#convertTextEditFromUtf16(textEdit, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return textEdit;
		}
		return {
			...textEdit,
			range: this.#convertRangeFromUtf16(textEdit.range, document),
		};
	}

	#convertRangeToUtf16(range, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return range;
		}
		return {
			start: this.#convertPositionToUtf16(range.start, document),
			end: this.#convertPositionToUtf16(range.end, document),
		};
	}

	#convertRangeFromUtf16(range, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return range;
		}
		return {
			start: this.#convertPositionFromUtf16(range.start, document),
			end: this.#convertPositionFromUtf16(range.end, document),
		};
	}

	#convertPositionToUtf16(position, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return position;
		}
		const lineText = this.#getLineText(document, position.line);
		if (this.#positionEncoding === PositionEncodingKind.UTF8) {
			return {
				line: position.line,
				character: this.#utf8IndexToUtf16(lineText, position.character),
			};
		}
		return {
			line: position.line,
			character: this.#utf32IndexToUtf16(lineText, position.character),
		};
	}

	#convertPositionFromUtf16(position, document) {
		if (this.#positionEncoding === PositionEncodingKind.UTF16) {
			return position;
		}
		const lineText = this.#getLineText(document, position.line);
		if (this.#positionEncoding === PositionEncodingKind.UTF8) {
			return {
				line: position.line,
				character: this.#utf16IndexToUtf8(lineText, position.character),
			};
		}
		return {
			line: position.line,
			character: this.#utf16IndexToUtf32(lineText, position.character),
		};
	}

	#utf16IndexToUtf8(text, index) {
		if (index <= 0) {
			return 0;
		}
		return Buffer.from(text.slice(0, index), "utf8").length;
	}

	#utf8IndexToUtf16(text, index) {
		if (index <= 0) {
			return 0;
		}
		let utf8Count = 0;
		let utf16Index = 0;
		for (const char of text) {
			const charSize = Buffer.from(char, "utf8").length;
			if (utf8Count + charSize > index) {
				break;
			}
			utf8Count += charSize;
			utf16Index += char.length;
		}
		return Math.min(utf16Index, text.length);
	}

	#utf16IndexToUtf32(text, index) {
		if (index <= 0) {
			return 0;
		}
		let count = 0;
		let seen = 0;
		for (const char of text) {
			if (seen + char.length > index) {
				break;
			}
			seen += char.length;
			count += 1;
		}
		return count;
	}

	#utf32IndexToUtf16(text, index) {
		if (index <= 0) {
			return 0;
		}
		let count = 0;
		let utf16Index = 0;
		for (const char of text) {
			if (count >= index) {
				break;
			}
			count += 1;
			utf16Index += char.length;
		}
		return Math.min(utf16Index, text.length);
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

	#rangesOverlap(range1, range2) {
		// Check if two ranges overlap
		// Range 1 ends before Range 2 starts
		if (
			range1.end.line < range2.start.line ||
			(range1.end.line === range2.start.line &&
				range1.end.character <= range2.start.character)
		) {
			return false;
		}
		// Range 2 ends before Range 1 starts
		if (
			range2.end.line < range1.start.line ||
			(range2.end.line === range1.start.line &&
				range2.end.character <= range1.start.character)
		) {
			return false;
		}
		// Ranges overlap
		return true;
	}
}
