import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { loadConfig } from "../lib/config.mjs";

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
