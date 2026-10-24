import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { loadConfig } from "../lib/config.mjs";
import { TestLanguageClient } from "./helpers.mjs";

describe("Config Log Redaction", () => {
	it("should redact sensitive values in log output", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-log-"),
		);
		const configPath = path.join(tempDir, ".markdownlint-cli2.jsonc");
		const docPath = path.join(tempDir, "log-redaction.md");
		const messages = [];

		try {
			await fs.writeFile(
				configPath,
				JSON.stringify({
					config: {
						default: true,
						apiKey: "supersecret",
						password: "secret",
					},
					token: "topsecret",
				}),
			);
			await fs.writeFile(docPath, "# Heading\n");

			await loadConfig(pathToFileURL(docPath).href, tempDir, (message) => {
				messages.push(message);
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}

		const logOutput = messages.join("\n");
		expect(logOutput).to.not.include("supersecret");
		expect(logOutput).to.not.include("topsecret");
	});
});

describe("Configuration logs over LSP", function () {
	this.timeout(10000);

	for (const trace of ["messages", "verbose"]) {
		for (const source of [
			"initialization",
			"pulled settings",
			"document config",
		]) {
			it(`does not disclose ${source} credentials with ${trace} tracing`, async () => {
				const tempDir = await fs.mkdtemp(
					path.join(os.tmpdir(), "markdownlint-lsp-trace-"),
				);
				const configPath = path.join(tempDir, ".markdownlint-cli2.jsonc");
				const uri = pathToFileURL(path.join(tempDir, "test.md")).href;
				const credentials = {
					apiKey: "dummy-api-key-123",
					token: "dummy-token-456",
					password: "dummy-password-789",
				};
				const options = {
					config: { default: true, pluginOptions: credentials },
					markdownItPlugins: [["dummy-plugin", credentials]],
				};
				const client = new TestLanguageClient({
					rootUri: pathToFileURL(tempDir).href,
					trace,
					initializationOptions: source === "initialization" ? options : {},
					configurationSettings: source === "pulled settings" ? options : {},
				});

				try {
					if (source === "document config") {
						await fs.writeFile(configPath, JSON.stringify(options));
					}
					await client.start();
					const diagnosticsPromise = client.waitForDiagnostics(uri);
					await client.openTextDocument(uri, "#Missing space\n");
					const { diagnostics } = await diagnosticsPromise;
					expect(diagnostics.some(({ code }) => code === "MD018")).to.equal(
						true,
					);
				} finally {
					await client.stop();
					await fs.rm(tempDir, { recursive: true, force: true });
				}

				const traceOutput = client.traceMessages
					.map(({ message }) => message)
					.join("\n");
				const messageOutput = client.logMessages
					.map(({ message }) => message)
					.join("\n");
				expect(traceOutput).to.include("Server initialized.");
				expect(traceOutput).to.include(`Validating: ${uri}`);
				expect(traceOutput).to.include(`for ${uri} v1`);
				expect(messageOutput).to.include(
					source === "document config"
						? `using config ${configPath}`
						: "using defaults",
				);
				expect(messageOutput).to.include(
					"loading modules requires allowJavaScriptConfig",
				);
				for (const value of Object.values(credentials)) {
					expect(traceOutput).to.not.include(value);
					expect(messageOutput).to.not.include(value);
				}
			});
		}
	}
});
