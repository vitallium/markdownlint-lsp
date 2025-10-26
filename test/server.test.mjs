import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Markdownlint Language Server", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	describe("Server Initialization", () => {
		it("should successfully initialize the language server", async () => {
			expect(client.state).to.equal(2); // Running state
		});

		it("should support markdown documents", async () => {
			const capabilities = client.capabilities;
			expect(capabilities).to.exist;
			expect(capabilities.textDocumentSync).to.exist;
		});
	});

	describe("Document Diagnostics", () => {
		it("should publish diagnostics for documents with errors", async () => {
			const uri = createTestDocumentUri("sample-with-errors.md");
			const content = fs.readFileSync(
				path.join(__dirname, "fixtures", "sample-with-errors.md"),
				"utf8",
			);

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			expect(publishedDiagnostics).to.be.an("array");
			expect(publishedDiagnostics.length).to.be.greaterThan(0);

			// Check for representative errors
			const errorCodes = publishedDiagnostics.map((d) => d.code);
			expect(errorCodes).to.include.members([
				"MD010", // no-hard-tabs
				"MD012", // no-multiple-blanks
				"MD018", // no-missing-space-atx
			]);
		});

		it("should not publish diagnostics for clean documents", async () => {
			const uri = createTestDocumentUri("clean.md");
			const content = fs.readFileSync(
				path.join(__dirname, "fixtures", "clean.md"),
				"utf8",
			);

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			expect(publishedDiagnostics).to.be.an("array");
			expect(publishedDiagnostics.length).to.equal(0);
		});

		it("should include correct diagnostic information", async () => {
			const uri = createTestDocumentUri("test-diagnostic-info.md");
			const content = "#No space after hash\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const diagnostic = publishedDiagnostics.find((d) => d.code === "MD018");
			expect(diagnostic).to.exist;

			expect(diagnostic.message).to.include("space");
			expect(diagnostic.severity).to.exist;
			expect(diagnostic.range).to.exist;
			expect(diagnostic.range.start.line).to.equal(0);
		});

		it("should provide diagnostic source", async () => {
			const uri = createTestDocumentUri("test-source.md");
			const content = "# Heading\n\n\n\nToo many blank lines\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const diagnostic = publishedDiagnostics.find((d) => d.code === "MD012");
			expect(diagnostic).to.exist;
			expect(diagnostic.source).to.equal("markdownlint");
		});
	});

	describe("Document Changes", () => {
		it("should update diagnostics when document changes", async () => {
			const uri = createTestDocumentUri("test-changes.md");
			const initialContent = "# Valid Heading\n";

			// Open with valid content
			await client.openTextDocument(uri, initialContent);
			let { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);
			expect(publishedDiagnostics).to.have.lengthOf(0);

			// Change to invalid content
			await client.changeTextDocument(uri, 2, [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 15 },
					},
					text: "#Invalid Heading",
				},
			]);

			({ diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri));
			expect(publishedDiagnostics).to.have.lengthOf.at.least(1);
			expect(publishedDiagnostics[0].code).to.equal("MD018");
		});

		it("should clear diagnostics when errors are fixed", async () => {
			const uri = createTestDocumentUri("test-fix-errors.md");
			const errorContent = "#No space\n";

			// Open with error
			await client.openTextDocument(uri, errorContent);
			let { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);
			expect(publishedDiagnostics).to.have.lengthOf.at.least(1);

			// Fix the error
			await client.changeTextDocument(uri, 2, [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 9 },
					},
					text: "# With space",
				},
			]);

			({ diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri));
			expect(publishedDiagnostics).to.have.lengthOf(0);
		});
	});

	describe("Configuration Loading", () => {
		it("should respect .markdownlint.json configuration", async () => {
			const configDir = path.join(__dirname, "fixtures", "configs");
			const uri = `file://${path.join(configDir, "test-with-config.md")}`;

			// MD013 (line-length) is disabled in the config
			const content =
				"This is a very long line that would normally trigger MD013 line length rule but should be ignored due to configuration settings\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md013Diagnostic = publishedDiagnostics.find(
				(d) => d.code === "MD013",
			);
			expect(md013Diagnostic).to.be.undefined;
		});

		it("should allow HTML elements specified in configuration", async () => {
			const configDir = path.join(__dirname, "fixtures", "configs");
			const uri = `file://${path.join(configDir, "test-allowed-html.md")}`;

			// br and hr are allowed in the config
			const content =
				"Line with break<br>\n\n<hr>\n\n<script>Not allowed</script>\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			// Should not have errors for br and hr, but should for script
			const md033Diagnostics = publishedDiagnostics.filter(
				(d) => d.code === "MD033",
			);
			expect(md033Diagnostics).to.have.lengthOf(1);
			expect(md033Diagnostics[0].range.start.line).to.equal(4);
		});
	});

	describe("File Watching", () => {
		it("should re-validate when configuration file changes", async () => {
			const tempDir = path.join(__dirname, "fixtures", "temp-watch");
			await fs.promises.rm(tempDir, { recursive: true, force: true });
			await fs.promises.mkdir(tempDir, { recursive: true });

			const configPath = path.join(tempDir, ".markdownlint.json");
			const documentPath = path.join(tempDir, "watch.md");
			const documentUri = pathToFileURL(documentPath).href;

			const initialConfig = {
				default: true,
				MD009: false,
			};
			await fs.promises.writeFile(
				configPath,
				JSON.stringify(initialConfig),
				"utf8",
			);

			const content = "Trailing spaces    \n";
			await client.openTextDocument(documentUri, content);
			let { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(documentUri);
			let md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.be.undefined;

			const updatedConfig = {
				default: true,
				MD009: true,
			};
			await fs.promises.writeFile(
				configPath,
				JSON.stringify(updatedConfig),
				"utf8",
			);

			const configUri = pathToFileURL(configPath).href;
			const diagnosticsPromise = client.waitForDiagnostics(documentUri);
			await client.sendRawNotification("workspace/didChangeWatchedFiles", {
				changes: [
					{
						uri: configUri,
						type: 2,
					},
				],
			});

			({ diagnostics: publishedDiagnostics } = await diagnosticsPromise);
			md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.exist;

			await client.closeTextDocument(documentUri);
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		});
	});

	describe("Multiple Documents", () => {
		it("should handle multiple open documents independently", async () => {
			const uri1 = createTestDocumentUri("multi-doc-1.md");
			const uri2 = createTestDocumentUri("multi-doc-2.md");

			const content1 = "#No space\n";
			const content2 = "# Valid heading\n";

			const diagnosticsPromise1 = client.waitForDiagnostics(uri1);
			await client.openTextDocument(uri1, content1);

			const diagnosticsPromise2 = client.waitForDiagnostics(uri2);
			await client.openTextDocument(uri2, content2);

			const report1 = await diagnosticsPromise1;
			const report2 = await diagnosticsPromise2;

			expect(report1.diagnostics).to.have.lengthOf.at.least(1);
			expect(report2.diagnostics).to.have.lengthOf(0);
		});
	});

	describe("Document Lifecycle", () => {
		it("should clear diagnostics when document is closed", async () => {
			const uri = createTestDocumentUri("test-close.md");
			const content = "#Error\n";

			await client.openTextDocument(uri, content);
			let { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);
			expect(publishedDiagnostics).to.have.lengthOf.at.least(1);

			await client.closeTextDocument(uri);

			// Server should publish empty diagnostics when document is closed
			({ diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri));
			expect(publishedDiagnostics).to.have.lengthOf(0);
		});
	});

	describe("Error Handling", () => {
		it("should handle malformed markdown gracefully", async () => {
			const uri = createTestDocumentUri("malformed.md");
			const content = "```\nunclosed code block\n# Heading inside code?\n";

			await client.openTextDocument(uri, content);

			// Should still produce diagnostics without crashing
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);
			expect(publishedDiagnostics).to.be.an("array");
			// Should have at least one diagnostic for unclosed code block
			expect(publishedDiagnostics.length).to.be.greaterThan(0);
		});

		it("should handle empty documents", async () => {
			const uri = createTestDocumentUri("empty.md");
			const content = "";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			expect(publishedDiagnostics).to.be.an("array");
			// May or may not have diagnostics depending on configuration
		});

		it("should handle very large documents", async () => {
			const uri = createTestDocumentUri("large.md");
			// Generate a large document
			let content = "# Large Document\n\n";
			for (let i = 0; i < 1000; i++) {
				content += `## Section ${i}\n\nThis is paragraph ${i} with some content.\n\n`;
			}

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			expect(publishedDiagnostics).to.be.an("array");
			// Should complete without timeout
		});
	});

	describe("Diagnostic Ranges", () => {
		it("should provide accurate ranges for errors", async () => {
			const uri = createTestDocumentUri("test-ranges.md");
			const content = "# Heading\n\n#No space\n\nContent\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md018Diagnostic = publishedDiagnostics.find(
				(d) => d.code === "MD018",
			);
			expect(md018Diagnostic).to.exist;
			expect(md018Diagnostic.range.start.line).to.equal(2); // Third line (0-indexed)
			expect(md018Diagnostic.range.start.character).to.equal(0);
			expect(md018Diagnostic.range.end.line).to.equal(2);
			expect(md018Diagnostic.range.end.character).to.be.greaterThan(0);
		});
	});

	describe("Rule-Specific Tests", () => {
		it("should detect MD001 - heading increment", async () => {
			const uri = createTestDocumentUri("md001.md");
			const content = "# Heading 1\n### Heading 3\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md001 = publishedDiagnostics.find((d) => d.code === "MD001");
			expect(md001).to.exist;
		});

		it("should detect MD009 - trailing spaces", async () => {
			const uri = createTestDocumentUri("md009.md");
			const content = "This line has trailing spaces    \n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.exist;
		});

		it("should detect MD010 - hard tabs", async () => {
			const uri = createTestDocumentUri("md010.md");
			const content = "\tThis line starts with a tab\n";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md010 = publishedDiagnostics.find((d) => d.code === "MD010");
			expect(md010).to.exist;
		});

		it("should detect MD047 - missing trailing newline", async () => {
			const uri = createTestDocumentUri("md047.md");
			const content = "# Heading\n\nNo trailing newline";

			await client.openTextDocument(uri, content);
			const { diagnostics: publishedDiagnostics } =
				await client.waitForDiagnostics(uri);

			const md047 = publishedDiagnostics.find((d) => d.code === "MD047");
			expect(md047).to.exist;
		});
	});
});
