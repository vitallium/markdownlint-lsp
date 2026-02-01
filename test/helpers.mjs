import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MockLanguageClient extends EventEmitter {
	constructor(options = {}) {
		super();
		this.options = options;
		this.state = 0; // 0 = stopped, 1 = starting, 2 = running
		this.initializeResult = {
			capabilities: {
				textDocumentSync: 2,
				diagnosticProvider: {
					interFileDependencies: false,
					workspaceDiagnostics: false,
				},
			},
		};
		this.messageId = 0;
		this.pendingRequests = new Map();
		this.diagnosticsHandlers = [];
	}

	async sendRequest(method, params) {
		const id = ++this.messageId;
		const message = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.sendMessage(message);
		});
	}

	async sendNotification(method, params) {
		const message = {
			jsonrpc: "2.0",
			method,
			params,
		};
		this.sendMessage(message);
	}

	sendMessage(message) {
		const content = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
		this.process.stdin.write(header + content);
	}

	onNotification(method, handler) {
		if (method === "textDocument/publishDiagnostics") {
			this.diagnosticsHandlers.push(handler);
		}
	}

	handleMessage(message) {
		if (message.id && this.pendingRequests.has(message.id)) {
			const { resolve, reject } = this.pendingRequests.get(message.id);
			this.pendingRequests.delete(message.id);
			if (message.error) {
				reject(new Error(message.error.message));
			} else {
				resolve(message.result);
			}
		} else if (message.method === "textDocument/publishDiagnostics") {
			for (const handler of this.diagnosticsHandlers) {
				handler(message.params);
			}
		}
	}

	async start() {
		this.state = 1;
		const serverPath = path.join(__dirname, "..", "lib", "index.mjs");
		this.process = spawn("node", [serverPath, "--stdio"], {
			cwd: path.join(__dirname, ".."),
			env: process.env,
			stdio: ["pipe", "pipe", "inherit"],
		});

		this.buffer = "";
		this.contentLength = null;

		this.process.stdout.on("data", (data) => {
			this.buffer += data.toString();
			this.processBuffer();
		});

		this.process.on("exit", (code) => {
			this.state = 0;
			this.emit("exit", code);
		});

		const baseCapabilities = {
			textDocument: {
				synchronization: {
					dynamicRegistration: false,
					willSave: false,
					willSaveWaitUntil: false,
					didSave: true,
				},
				publishDiagnostics: {
					relatedInformation: true,
					versionSupport: true,
					codeDescriptionSupport: true,
					dataSupport: true,
				},
			},
			workspace: {
				workspaceFolders: true,
				configuration: true,
				didChangeConfiguration: {
					dynamicRegistration: false,
				},
				didChangeWatchedFiles: {
					dynamicRegistration: false,
				},
			},
		};

		const capabilities = {
			textDocument: {
				...baseCapabilities.textDocument,
				...this.options.capabilities?.textDocument,
				synchronization: {
					...baseCapabilities.textDocument.synchronization,
					...this.options.capabilities?.textDocument?.synchronization,
				},
				publishDiagnostics: {
					...baseCapabilities.textDocument.publishDiagnostics,
					...this.options.capabilities?.textDocument?.publishDiagnostics,
				},
			},
			workspace: {
				...baseCapabilities.workspace,
				...this.options.capabilities?.workspace,
				didChangeConfiguration: {
					...baseCapabilities.workspace.didChangeConfiguration,
					...this.options.capabilities?.workspace?.didChangeConfiguration,
				},
				didChangeWatchedFiles: {
					...baseCapabilities.workspace.didChangeWatchedFiles,
					...this.options.capabilities?.workspace?.didChangeWatchedFiles,
				},
			},
			general: {
				...this.options.capabilities?.general,
			},
		};

		const initializationOptions = {
			validationDelay: 0,
			...this.options.initializationOptions,
		};

		// Send initialize request
		const result = await this.sendRequest("initialize", {
			processId: process.pid,
			clientInfo: {
				name: "markdownlint-test-client",
				version: "1.0.0",
			},
			rootUri: `file://${path.join(__dirname, "fixtures")}`,
			capabilities,
			workspaceFolders: [
				{
					uri: `file://${path.join(__dirname, "fixtures")}`,
					name: "test-fixtures",
				},
			],
			initializationOptions,
		});

		this.initializeResult = result;
		await this.sendNotification("initialized", {});
		this.state = 2;
		return result;
	}

	processBuffer() {
		while (true) {
			if (this.contentLength === null) {
				const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
				if (!headerMatch) {
					break;
				}
				this.contentLength = parseInt(headerMatch[1], 10);
				this.buffer = this.buffer.slice(headerMatch[0].length);
			}

			if (this.buffer.length < this.contentLength) {
				break;
			}

			const content = this.buffer.slice(0, this.contentLength);
			this.buffer = this.buffer.slice(this.contentLength);
			this.contentLength = null;

			try {
				const message = JSON.parse(content);
				this.handleMessage(message);
			} catch (e) {
				console.error("Failed to parse message:", e);
			}
		}
	}

	async stop() {
		if (this.state === 2) {
			await this.sendRequest("shutdown", null);
			await this.sendNotification("exit", null);
		}
		if (this.process) {
			this.process.kill();
		}
		this.state = 0;
	}
}

export class TestLanguageClient {
	#client;

	constructor(options = {}) {
		this.#client = new MockLanguageClient(options);
	}

	get state() {
		return this.#client.state;
	}

	get capabilities() {
		return this.#client.initializeResult?.capabilities;
	}

	async start() {
		await this.#client.start();
		return this.#client;
	}

	async stop() {
		await this.#client.stop();
	}

	async sendRawNotification(method, params) {
		await this.#client.sendNotification(method, params);
	}

	async openTextDocument(uri, content) {
		await this.#client.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: "markdown",
				version: 1,
				text: content,
			},
		});
	}

	async changeTextDocument(uri, version, changes) {
		await this.#client.sendNotification("textDocument/didChange", {
			textDocument: {
				uri,
				version,
			},
			contentChanges: changes,
		});
	}

	async closeTextDocument(uri) {
		await this.#client.sendNotification("textDocument/didClose", {
			textDocument: {
				uri,
			},
		});
	}

	async requestCodeActions(uri, range, diagnostics = []) {
		return this.#client.sendRequest("textDocument/codeAction", {
			textDocument: {
				uri,
			},
			range,
			context: {
				diagnostics,
				only: ["source.fixAll", "quickfix"],
			},
		});
	}

	async waitForDiagnostics(uri, timeout = 5000) {
		return new Promise((resolve, reject) => {
			let timeoutId;

			const diagnosticsHandler = (params) => {
				if (params.uri === uri) {
					clearTimeout(timeoutId);
					this.#client.diagnosticsHandlers =
						this.#client.diagnosticsHandlers.filter(
							(h) => h !== diagnosticsHandler,
						);
					resolve(params);
				}
			};

			timeoutId = setTimeout(() => {
				this.#client.diagnosticsHandlers =
					this.#client.diagnosticsHandlers.filter(
						(h) => h !== diagnosticsHandler,
					);
				reject(new Error("Timeout waiting for diagnostics"));
			}, timeout);

			this.#client.onNotification(
				"textDocument/publishDiagnostics",
				diagnosticsHandler,
			);
		});
	}

	async waitForDiagnosticsArray(uri, timeout = 5000) {
		const { diagnostics } = await this.waitForDiagnostics(uri, timeout);
		return diagnostics;
	}
}

export function createTestDocumentUri(filename) {
	return `file://${path.join(__dirname, "fixtures", filename)}`;
}

export function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const markdownlintRules = {
	MD001: "heading-increment",
	MD002: "first-heading-h1",
	MD003: "heading-style",
	MD004: "ul-style",
	MD005: "list-indent",
	MD006: "ul-start-left",
	MD007: "ul-indent",
	MD009: "no-trailing-spaces",
	MD010: "no-hard-tabs",
	MD011: "no-reversed-links",
	MD012: "no-multiple-blanks",
	MD013: "line-length",
	MD014: "commands-show-output",
	MD018: "no-missing-space-atx",
	MD019: "no-multiple-space-atx",
	MD020: "no-missing-space-closed-atx",
	MD021: "no-multiple-space-closed-atx",
	MD022: "blanks-around-headings",
	MD023: "heading-start-left",
	MD024: "no-duplicate-heading",
	MD025: "single-title",
	MD026: "no-trailing-punctuation",
	MD027: "no-multiple-space-blockquote",
	MD028: "no-blanks-blockquote",
	MD029: "ol-prefix",
	MD030: "list-marker-space",
	MD031: "blanks-around-fences",
	MD032: "blanks-around-lists",
	MD033: "no-inline-html",
	MD034: "no-bare-urls",
	MD035: "hr-style",
	MD036: "no-emphasis-as-heading",
	MD037: "no-space-in-emphasis",
	MD038: "no-space-in-code",
	MD039: "no-space-in-links",
	MD040: "fenced-code-language",
	MD041: "first-line-heading",
	MD042: "no-empty-links",
	MD043: "required-headings",
	MD044: "proper-names",
	MD045: "no-alt-text",
	MD046: "code-block-style",
	MD047: "single-trailing-newline",
	MD048: "code-fence-style",
	MD049: "emphasis-style",
	MD050: "strong-style",
	MD051: "link-fragments",
	MD052: "reference-links-images",
	MD053: "link-image-reference-definitions",
	MD054: "link-image-style",
	MD055: "table-pipe-style",
	MD056: "table-column-count",
};
