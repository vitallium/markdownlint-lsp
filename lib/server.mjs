import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	CodeActionKind,
	createConnection,
	DidChangeWatchedFilesNotification,
	PositionEncodingKind,
	ProposedFeatures,
	TextDocumentSyncKind,
	TraceValues,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CodeActions } from "./code-actions.mjs";
import {
	ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON,
	MARKDOWNLINT_IGNORE_FILENAME,
} from "./config.mjs";
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
	#settings = {};
	#trace = TraceValues.Off;
	#validationDelay = DEFAULT_VALIDATION_DELAY_MS;
	#initializationOptions = {};
	#hasDidChangeWatchedFilesCapability = false;
	#hasRelativePatternSupport = false;
	#hasWorkspaceFoldersCapability = false;
	#hasConfigurationCapability = false;
	#hasDocumentChangesCapability = false;
	#initialConfigurationPromise = null;
	#documentDependencies = new Map();
	#dependencyWatchRegistration = null;
	#dependencyWatchKey = "[]";
	#dependencyWatchUpdate = null;
	#documentFixes = new Map();
	#documentIssues = new Map();
	#allowJavaScriptConfig = false;
	#runtime = new DocumentRuntime(DEFAULT_VALIDATION_DELAY_MS);
	#codec = new PositionCodec();
	#validator = new DocumentValidator({
		codec: this.#codec,
		logger: (message, level) => this.#logConfig(message, level),
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
			this.#hasRelativePatternSupport =
				params.capabilities.workspace?.didChangeWatchedFiles
					?.relativePatternSupport ?? false;

			this.#hasWorkspaceFoldersCapability =
				params.capabilities.workspace?.workspaceFolders === true;
			this.#hasConfigurationCapability =
				params.capabilities.workspace?.configuration === true;
			this.#hasDocumentChangesCapability =
				params.capabilities.workspace?.workspaceEdit?.documentChanges === true;

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

			this.#logTrace("Initial server configuration loaded.");

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
			if (this.#hasConfigurationCapability) {
				this.#initialConfigurationPromise = this.#fetchSettings();
			}
			if (this.#hasDidChangeWatchedFilesCapability) {
				// The register request can be rejected (capability withdrawn,
				// handler unimplemented); an unhandled rejection would kill the
				// server, so log the failure instead and keep serving.
				this.#connection.client
					.register(DidChangeWatchedFilesNotification.type, {
						watchers: [
							...ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON.map((pattern) => ({
								globPattern: `**/${pattern}`,
							})),
							{
								globPattern: `**/${MARKDOWNLINT_IGNORE_FILENAME}`,
							},
							// package.json is only read as a config source at each
							// workspace folder root; a bare glob covers exactly that
							// scope, so package.json churn elsewhere (e.g. under
							// node_modules during an install) does not fire watchers
							// and clear the config cache.
							{
								globPattern: "package.json",
							},
						],
					})
					.catch((error) => {
						this.#logConfig(
							`Unable to register configuration file watchers: ${error}`,
							"warning",
						);
					});
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
			this.#clearDocumentResults(params.textDocument.uri);
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
				this.#clearDocumentResults(params.textDocument.uri);
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
			this.#documentDependencies.delete(params.textDocument.uri);
			// Reopening must reload changes made after its dependency watches stop.
			this.#workspace.invalidateDocumentOptions(params.textDocument.uri);
			this.#syncDependencyWatchers();

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
			await this.#initialConfigurationPromise;
			await this.#fetchSettings();
			this.#revalidateAllDocuments();
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
				documentChanges: this.#hasDocumentChangesCapability,
			});
		});
	}

	async validateDocument(document) {
		// Runtime updates mutate TextDocument in place. Keep validation input and
		// its version stable across configuration loading and asynchronous linting.
		const sourceDocument = document;
		document = TextDocument.create(
			document.uri,
			document.languageId,
			document.version,
			document.getText(),
		);
		const currentVersion = document.version;
		const isCurrentDocument = () =>
			this.#runtime.get(document.uri) === sourceDocument &&
			this.#runtime.hasLatestVersion(document.uri, currentVersion);

		if (document.languageId !== "markdown") {
			this.#logTrace(`Unsupported languageId: ${document.languageId}`);
			return;
		}

		if (this.#initialConfigurationPromise) {
			await this.#initialConfigurationPromise;
		}
		this.#logTrace(`Validating: ${document.uri}`);

		const { documentOptions, workspaceRoot, configDependencies } =
			await this.#workspace.loadDocumentOptions(
				document.uri,
				this.#allowJavaScriptConfig,
				this.#logConfig.bind(this),
			);

		if (this.#hasDidChangeWatchedFilesCapability && isCurrentDocument()) {
			this.#documentDependencies.set(document.uri, configDependencies);
			await this.#syncDependencyWatchers();
		}

		try {
			const result = await this.#validator.validate({
				document,
				documentOptions,
				settings: this.#settings,
				workspaceRoot,
				allowJavaScriptConfig: this.#allowJavaScriptConfig,
			});

			if (!isCurrentDocument()) {
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
			if (!isCurrentDocument()) {
				return;
			}
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

	#logConfig(message, level) {
		if (level === "info" || level === "warning" || level === "error") {
			this.#connection.sendNotification("window/logMessage", {
				type: { error: 1, warning: 2, info: 3 }[level],
				message: `[markdownlint-lsp] ${message}`,
			});
			return;
		}
		this.#logTrace(message);
	}

	setupWorkspaceEventHandlers() {
		this.#connection.workspace.onDidChangeWorkspaceFolders((event) => {
			this.#logTrace("Workspace folders changed.");
			this.#workspace.updateWorkspaceFolders(event, this.#logTrace.bind(this));
			this.#documentDependencies.clear();
			this.#syncDependencyWatchers();
			this.#revalidateAllDocuments();
		});
	}

	async #syncDependencyWatchers() {
		if (!this.#hasDidChangeWatchedFilesCapability) return;
		// Serialize replacements. A caller arriving while an update is in
		// flight must not adopt that update: its file snapshot may predate the
		// caller's dependency, so the returned promise could settle without
		// ever registering it. Wait for the in-flight update to finish —
		// including the .finally that clears this field — then start a fresh
		// replacement pass. The key check at the top of
		// #replaceDependencyWatchers makes redundant passes cheap no-ops, and
		// microtask continuations run serially, so concurrent waiters converge
		// on a single pass each instead of chaining forever.
		while (this.#dependencyWatchUpdate) {
			await this.#dependencyWatchUpdate;
		}
		this.#dependencyWatchUpdate = this.#replaceDependencyWatchers()
			.catch((error) => {
				this.#logConfig(
					`Unable to watch extended configuration: ${error}`,
					"warning",
				);
			})
			.finally(() => {
				this.#dependencyWatchUpdate = null;
			});
		return this.#dependencyWatchUpdate;
	}

	async #replaceDependencyWatchers() {
		while (true) {
			const files = [
				...new Set(
					[...this.#documentDependencies.values()].flatMap((files) => [
						...files,
					]),
				),
			].sort();
			const key = JSON.stringify(files);
			if (key === this.#dependencyWatchKey) return;
			const registration = files.length
				? await this.#connection.client.register(
						DidChangeWatchedFilesNotification.type,
						{
							watchers: files.map((file) => {
								const pattern = this.#hasRelativePatternSupport
									? path.basename(file)
									: file.split(path.sep).join("/");
								const escaped = pattern.replace(
									/[*?{}[\]]/g,
									(character) => `[${character}]`,
								);
								return {
									// Relative bases let clients watch outside roots and excluded directories.
									globPattern: this.#hasRelativePatternSupport
										? {
												baseUri: pathToFileURL(path.dirname(file)).href,
												pattern: escaped,
											}
										: escaped,
								};
							}),
						},
					)
				: null;
			this.#dependencyWatchRegistration?.dispose();
			this.#dependencyWatchRegistration = registration;
			this.#dependencyWatchKey = key;
		}
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
				// A closed document's validation must not finish the validation
				// state belonging to a new document opened at the same URI.
				if (this.#runtime.get(documentToValidate.uri) !== documentToValidate) {
					return;
				}
				const queued = this.#runtime.finishValidation(documentToValidate.uri);
				if (queued) {
					this.#enqueueValidation(queued);
				}
			});
	}

	async #fetchSettings() {
		try {
			const settings =
				await this.#connection.workspace.getConfiguration("markdownlint");
			const initializationSettings = this.#resolveSettings(
				this.#initializationOptions,
			);
			const resolvedSettings = this.#resolveSettings(settings ?? {});
			this.#settings = mergeOptions(initializationSettings, resolvedSettings);
			this.#logTrace("Server configuration updated from workspace settings.");
		} catch (error) {
			this.#logTrace(`Error fetching configuration: ${error}`);
		}
	}

	#resolveSettings(settings) {
		const resolvedSettings =
			settings && typeof settings === "object" ? settings : {};
		const { validationDelay, ...options } = resolvedSettings;
		return options;
	}
}
