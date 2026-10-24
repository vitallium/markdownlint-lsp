import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

const ignores = [null, 42, {}, true, [], "dist", "**/*.generated.md"];

describe("IgnorePatternSet invalid entries", () => {
	for (const source of ["CLI2 JSONC", "CLI2 YAML", "LSP settings"]) {
		it(`warns and preserves diagnostics and valid patterns from ${source}`, async () => {
			const root = await fs.mkdtemp(
				path.join(os.tmpdir(), "markdownlint-lsp-invalid-ignores-"),
			);
			const client = new TestLanguageClient({
				rootUri: pathToFileURL(root).href,
				configurationSettings: source === "LSP settings" ? { ignores } : {},
			});
			try {
				if (source === "CLI2 JSONC") {
					await fs.writeFile(
						path.join(root, ".markdownlint-cli2.jsonc"),
						JSON.stringify({ ignores }),
					);
				} else if (source === "CLI2 YAML") {
					await fs.writeFile(
						path.join(root, ".markdownlint-cli2.yaml"),
						'ignores:\n  -\n  - 42\n  - {}\n  - true\n  - []\n  - dist\n  - "**/*.generated.md"\n',
					);
				}
				await client.start();
				const uri = pathToFileURL(path.join(root, "document.md")).href;
				await client.openTextDocument(uri, "#No space\n");
				const diagnostics = await client.waitForDiagnosticsArray(uri);
				expect(diagnostics.map(({ code }) => code)).to.include("MD018");
				const warnings = client.logMessages.filter(
					({ type, message }) =>
						type === 2 && message.includes("ignore pattern"),
				);
				expect(warnings).to.have.lengthOf(5);
				for (const { message } of warnings) {
					expect(message).to.include("expected a string");
				}

				for (const filename of [
					"dist/nested/document.md",
					"document.generated.md",
				]) {
					const ignoredUri = pathToFileURL(path.join(root, filename)).href;
					await client.openTextDocument(ignoredUri, "#No space\n");
					expect(await client.waitForDiagnosticsArray(ignoredUri)).to.be.empty;
				}
			} finally {
				await client.stop();
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
