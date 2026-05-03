import {
	CodeActionKind,
	createConnection,
	DidChangeWatchedFilesNotification,
	PositionEncodingKind,
	ProposedFeatures,
	TextDocumentSyncKind,
	TraceValues,
} from "vscode-languageserver/node.js";
import { CodeActions } from "./code-actions.mjs";
import { ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON } from "./config.mjs";
import { DocumentRuntime } from "./document-runtime.mjs";
import { DocumentValidator } from "./document-validator.mjs";
import mergeOptions from "./merge-options.mjs";
import { PositionCodec } from "./position-codec.mjs";
import { WorkspaceContext } from "./workspace-context.mjs";

const DEFAULT_VALIDATION_DELAY_MS = 200;
const CONFIG_CHANGE_DEBOUNCE_MS = 300;
const CONFIG_CACHE_MAX_SIZE = 100;

export class Server {
	#connection;
	#settings = {
		config: {
			default: true,
		},
	};
	#trace = TraceValues.Off;
	#validationDelay = DEFAULT_VALIDATION_DELAY_MS;
	#initializationOptions = {};
	#hasDidChangeWatchedFilesCapability = false;
	#hasWorkspaceFoldersCapability = false;
	#documentFixes = new Map();
	#documentIssues = new Map();
	#allowJavaScriptConfig = false;
	#runtime = new DocumentRuntime(DEFAULT_VALIDATION_DELAY_MS);
	#codec = new PositionCodec();
	#validator = new DocumentValidator({
		codec: this.#codec,
		logger: (message) => this.#logTrace(message),
	});
	#codeActions = new CodeActions({
		codec: this.#codec,
		logger: (message) => this.#logTrace(message),
	});
	#workspace = new WorkspaceContext({
		configCacheMaxSize: CONFIG_CACHE_MAX_SIZE,
		configChangeDebounceMs: CONFIG_CHANGE_DEBOUNCE_MS,
	});

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
					this.#codec.setEncoding(PositionEncodingKind.UTF16);
				} else {
					this.#codec.setEncoding(clientPositionEncodings[0]);
					this.#logTrace(
						`Client does not advertise UTF-16 support. Using ${this.#codec.getEncoding()} while internal offsets remain UTF-16.`,
					);
				}
			}

			this.#hasDidChangeWatchedFilesCapability =
				params.capabilities.workspace?.didChangeWatchedFiles
					?.dynamicRegistration ?? false;

			this.#hasWorkspaceFoldersCapability =
				params.capabilities.workspace?.workspaceFolders === true;

			if (params.trace) {
				this.#trace = params.trace;
			}

			this.#workspace.initialize({
				rootPath: params.rootPath,
				rootUri: params.rootUri,
				workspaceFolders: params.workspaceFolders ?? [],
			});

			this.#initializationOptions = params.initializationOptions || {};
			this.#settings = this.#resolveSettings(this.#initializationOptions);
			this.#allowJavaScriptConfig =
				this.#initializationOptions.allowJavaScriptConfig === true;
			if (
				typeof this.#initializationOptions.validationDelay === "number" &&
				Number.isFinite(this.#initializationOptions.validationDelay)
			) {
				this.#validationDelay = Math.max(
					0,
					this.#initializationOptions.validationDelay,
				);
			}
			this.#runtime.setValidationDelay(this.#validationDelay);

			this.#logTrace(
				`Initial server configuration: ${JSON.stringify(this.#settings)}`,
			);

			return {
				capabilities: {
					textDocumentSync: TextDocumentSyncKind.Incremental,
					positionEncoding: this.#codec.getEncoding(),
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
			this.#workspace.scheduleConfigReload(
				() => this.#revalidateAllDocuments(),
				this.#logTrace.bind(this),
			);
		});

		this.#connection.onDidOpenTextDocument((params) => {
			const document = this.#runtime.open(params.textDocument);
			this.#logTrace(`Document opened: ${params.textDocument.uri}`);
			this.#scheduleValidation(document);
		});

		this.#connection.onDidChangeTextDocument((params) => {
			const document = this.#runtime.get(params.textDocument.uri);
			if (document) {
				const contentChanges =
					this.#codec.getEncoding() === PositionEncodingKind.UTF16
						? params.contentChanges
						: this.#codec.convertContentChangesToUtf16(
								params.contentChanges,
								document,
							);
				const updatedDocument = this.#runtime.update(
					params.textDocument,
					contentChanges,
				);
				this.#logTrace(
					`Document changed: ${params.textDocument.uri} v${params.textDocument.version}`,
				);
				this.#scheduleValidation(updatedDocument);
			}
		});

		this.#connection.onDidSaveTextDocument((params) => {
			this.#logTrace(`Document saved: ${params.textDocument.uri}`);
			const document = this.#runtime.save(params.textDocument.uri);
			if (document) {
				this.#enqueueValidation(document);
			}
		});

		this.#connection.onDidCloseTextDocument((params) => {
			this.#runtime.close(params.textDocument.uri);
			this.#clearDocumentResults(params.textDocument.uri);

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
			this.#workspace.clearCache();
			try {
				const settings =
					await this.#connection.workspace.getConfiguration("markdownlint");
				const initializationSettings = this.#resolveSettings(
					this.#initializationOptions,
				);
				const resolvedSettings = this.#resolveSettings(settings ?? {});
				this.#settings = mergeOptions(initializationSettings, resolvedSettings);
				this.#logTrace(
					`New server configuration: ${JSON.stringify(this.#settings)}`,
				);
				this.#revalidateAllDocuments();
			} catch (error) {
				this.#logTrace(`Error fetching configuration: ${error}`);
			}
		});

		this.#connection.onCodeAction((params) => {
			const uri = params.textDocument.uri;
			const document = this.#runtime.get(uri);

			if (!document) {
				return [];
			}

			return this.#codeActions.build({
				uri,
				document,
				params,
				diagnosticFixPairs: this.#documentFixes.get(uri),
				issues: this.#documentIssues.get(uri) ?? [],
			});
		});
	}

	async validateDocument(document) {
		if (document.languageId !== "markdown") {
			this.#logTrace(`Unsupported languageId: ${document.languageId}`);
			return;
		}

		this.#logTrace(`Validating: ${document.uri}`);

		const currentVersion = document.version;

		const { documentOptions, workspaceRoot } =
			await this.#workspace.loadDocumentOptions(
				document.uri,
				this.#allowJavaScriptConfig,
				this.#logTrace.bind(this),
			);

		this.#logTrace(
			`Will validate ${document.uri} with ${JSON.stringify(documentOptions)}`,
		);

		try {
			const result = await this.#validator.validate({
				document,
				documentOptions,
				settings: this.#settings,
				workspaceRoot,
			});

			if (!this.#runtime.hasLatestVersion(document.uri, currentVersion)) {
				this.#logTrace(
					`Discarding stale validation result for ${document.uri} v${currentVersion}`,
				);
				return;
			}

			if (result.ignored) {
				this.#clearDocumentResults(document.uri);
				this.#connection.sendDiagnostics({
					uri: document.uri,
					diagnostics: [],
				});
				return;
			}

			this.#documentFixes.set(document.uri, result.diagnosticFixPairs);
			this.#documentIssues.set(document.uri, result.issues);
			this.#connection.sendDiagnostics({
				uri: document.uri,
				diagnostics: result.diagnostics,
				version: currentVersion,
			});
			this.#logTrace(
				`Sent ${result.diagnostics.length} diagnostics (${result.diagnosticFixPairs.length} with fixes) for ${document.uri} v${currentVersion}`,
			);
		} catch (error) {
			this.#logTrace(`Linting error for ${document.uri}: ${error}`);
			// Clear stale diagnostics and fixes to avoid misleading users
			this.#clearDocumentResults(document.uri);
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

	setupWorkspaceEventHandlers() {
		this.#connection.workspace.onDidChangeWorkspaceFolders((event) => {
			this.#logTrace("Workspace folders changed.");
			this.#workspace.updateWorkspaceFolders(event, this.#logTrace.bind(this));
			this.#revalidateAllDocuments();
		});
	}

	#scheduleValidation(document) {
		this.#runtime.scheduleValidation(document, (currentDocument) => {
			this.#enqueueValidation(currentDocument);
		});
	}

	#revalidateAllDocuments() {
		for (const document of this.#runtime.getAll()) {
			this.#enqueueValidation(document);
		}
	}

	#clearDocumentResults(uri) {
		this.#documentFixes.delete(uri);
		this.#documentIssues.delete(uri);
	}

	#enqueueValidation(document) {
		const documentToValidate = this.#runtime.beginValidation(document);
		if (!documentToValidate) {
			return;
		}

		this.validateDocument(documentToValidate)
			.catch((error) => {
				this.#logTrace(
					`Validation error for ${documentToValidate.uri}: ${error}`,
				);
			})
			.finally(() => {
				const queued = this.#runtime.finishValidation(documentToValidate.uri);
				if (queued) {
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
}
