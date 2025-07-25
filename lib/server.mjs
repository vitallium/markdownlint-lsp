import { fileURLToPath } from "node:url";
import { lint } from "markdownlint/promise";
import {
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	DidChangeWatchedFilesNotification,
	PositionEncodingKind,
	ProposedFeatures,
	TextDocumentSyncKind,
	TraceValues,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON,
	loadConfig,
} from "./config.mjs";

export class Server {
	#connection;
	#documents = new Map();
	#config = {
		default: true,
	};
	#trace = TraceValues.Off;
	#rootPath = null;
	#workspaceFolders = [];
	#initializationOptions = {};
	#hasDidChangeWatchedFilesCapability = false;
	#hasWorkspaceFoldersCapability = false;
	#validationTimeouts = new Map();

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

			// TODO(vitallium): Migrate to workspaceFolders
			this.#rootPath = params.rootPath;
			this.#workspaceFolders = params.workspaceFolders || [];

			this.#initializationOptions = params.initializationOptions || {};
			this.#config = this.#initializationOptions.config || {};

			this.#logTrace(
				`Initial server configuration: ${JSON.stringify(this.#config)}`,
				true,
			);

			return {
				capabilities: {
					textDocumentSync: TextDocumentSyncKind.Incremental,
					positionEncoding: PositionEncodingKind.UTF16,
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
						watchers: ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON.map(
							(pattern) => ({
								globPattern: `**/${pattern}`,
							}),
						),
					},
				);
			}
		});

		this.#connection.onDidChangeWatchedFiles(async () => {
			this.#logTrace(
				"Configuration file changed. Re-validating all documents.",
			);
			for (const document of this.#documents.values()) {
				this.validateDocument(document);
			}
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
			this.validateDocument(document);
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
				this.validateDocument(updatedDocument);
			}
		});

		this.#connection.onWillSaveTextDocument((params) => {
			this.#logTrace(`Document will save: ${params.textDocument.uri}`);
		});

		this.#connection.onDidSaveTextDocument((params) => {
			this.#logTrace(`Document saved: ${params.textDocument.uri}`);
			const document = this.#documents.get(params.textDocument.uri);
			if (document) {
				this.throttledValidateDocument(document);
			}
		});

		this.#connection.onDidCloseTextDocument((params) => {
			this.#documents.delete(params.textDocument.uri);

			// Clear any pending validation timeouts
			if (this.#validationTimeouts.has(params.textDocument.uri)) {
				clearTimeout(this.#validationTimeouts.get(params.textDocument.uri));
				this.#validationTimeouts.delete(params.textDocument.uri);
			}

			this.#connection.sendDiagnostics({
				uri: params.textDocument.uri,
				diagnostics: [],
			});
			this.#logTrace(`Document closed: ${params.textDocument.uri}`);
		});

		this.#connection.onDidChangeConfiguration(async () => {
			this.#logTrace("Configuration changed. Re-validating all documents.");
			try {
				const settings =
					await this.#connection.workspace.getConfiguration("markdownlint");
				this.#config = {
					...this.#initializationOptions.config,
					...settings,
				};
				this.#logTrace(
					`New server configuration: ${JSON.stringify(this.#config)}`,
					true,
				);
				for (const document of this.#documents.values()) {
					this.validateDocument(document);
				}
			} catch (error) {
				this.#logTrace(`Error fetching configuration: ${error}`, true);
			}
		});

		if (this.#hasWorkspaceFoldersCapability) {
			this.setupWorkspaceEventHandlers();
		}
	}

	async validateDocument(document) {
		if (document.languageId !== "markdown") {
			this.#logTrace(`Unsupported languageId: ${document.languageId}`);
			return;
		}
		this.#logTrace(`Validating: ${document.uri}`);

		const workspaceRoot = this.#getWorkspaceRoot();
		const documentOptions =
			(await loadConfig(
				document.uri,
				workspaceRoot,
				this.#logTrace.bind(this),
			)) || {};

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
			const issues = results[document.uri] || [];
			const diagnostics = issues.map((issue) => {
				const line = (issue.lineNumber || 1) - 1;
				const [startChar, length] = issue.errorRange
					? [(issue.errorRange[0] || 1) - 1, issue.errorRange[1]]
					: [0, 1];

				return Diagnostic.create(
					{
						start: { line, character: startChar },
						end: { line, character: startChar + length },
					},
					`${issue.ruleDescription} (${issue.ruleNames.join("/")})`,
					DiagnosticSeverity.Warning,
					issue.ruleNames[0],
					"markdownlint",
				);
			});

			this.#connection.sendDiagnostics({ uri: document.uri, diagnostics });
			this.#logTrace(
				`Sent ${diagnostics.length} diagnostics for ${document.uri}`,
				true,
			);
		} catch (error) {
			this.#logTrace(`Linting error for ${document.uri}: ${error}`, true);
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

	#logTrace(message, verbose = false) {
		if (this.#trace === TraceValues.Off) {
			return;
		}
		this.#connection.tracer.log(message, verbose ? "verbose" : undefined);
	}

	#getWorkspaceRoot() {
		if (this.#workspaceFolders.length > 0) {
			// Use the first workspace folder as the primary root
			const firstFolder = this.#workspaceFolders[0];
			// Convert file URI to path properly
			return fileURLToPath(firstFolder.uri);
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

			this.#logTrace(
				`Updated workspace folders: ${this.#workspaceFolders.map((f) => f.uri).join(", ")}`,
				true,
			);
		});
	}

	throttledValidateDocument(document, delay = 300) {
		const uri = document.uri;

		if (this.#validationTimeouts.has(uri)) {
			clearTimeout(this.#validationTimeouts.get(uri));
		}

		const timeoutId = setTimeout(() => {
			this.#validationTimeouts.delete(uri);
			this.validateDocument(document);
		}, delay);

		this.#validationTimeouts.set(uri, timeoutId);
	}
}
