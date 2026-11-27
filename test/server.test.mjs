import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TextDocumentSyncKind } from "vscode-languageserver/node";
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

	it("advertises incremental document synchronization", () => {
		expect(client.capabilities.textDocumentSync).to.equal(
			TextDocumentSyncKind.Incremental,
		);
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

	describe("Workspace Folders", () => {
		it("should revalidate when a workspace folder is added", async () => {
			const tempRoot = path.join(
				os.tmpdir(),
				"markdownlint-lsp-workspace-folders",
			);
			const addedFolder = path.join(tempRoot, "added-workspace");
			const docPath = path.join(addedFolder, "workspace.md");
			const docUri = pathToFileURL(docPath).href;
			const isolatedClient = new TestLanguageClient({
				workspaceFolders: [],
				rootUri: `file://${path.join(__dirname, "fixtures")}`,
			});

			await fs.promises.rm(tempRoot, { recursive: true, force: true });
			await fs.promises.mkdir(addedFolder, { recursive: true });
			await fs.promises.writeFile(
				path.join(addedFolder, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD041: false,
				}),
				"utf8",
			);

			try {
				await isolatedClient.start();
				await isolatedClient.openTextDocument(
					docUri,
					"Not a heading\n\n# Heading\n",
				);

				let { diagnostics } = await isolatedClient.waitForDiagnostics(docUri);
				let md041 = diagnostics.find(
					(diagnostic) => diagnostic.code === "MD041",
				);
				expect(md041).to.exist;

				const diagnosticsPromise = isolatedClient.waitForDiagnostics(docUri);
				await isolatedClient.sendRawNotification(
					"workspace/didChangeWorkspaceFolders",
					{
						event: {
							added: [
								{
									uri: pathToFileURL(addedFolder).href,
									name: "added-workspace",
								},
							],
							removed: [],
						},
					},
				);

				({ diagnostics } = await diagnosticsPromise);
				md041 = diagnostics.find((diagnostic) => diagnostic.code === "MD041");
				expect(md041).to.be.undefined;
			} finally {
				await isolatedClient.stop();
				await fs.promises.rm(tempRoot, { recursive: true, force: true });
			}
		});

		it("should prefer the most specific matching workspace folder", async () => {
			const tempRoot = path.join(
				os.tmpdir(),
				"markdownlint-lsp-nested-workspaces",
			);
			const parentFolder = path.join(tempRoot, "parent");
			const nestedFolder = path.join(parentFolder, "nested");
			const docPath = path.join(nestedFolder, "workspace.md");
			const docUri = pathToFileURL(docPath).href;
			const isolatedClient = new TestLanguageClient({
				rootUri: pathToFileURL(parentFolder).href,
				workspaceFolders: [
					{
						uri: pathToFileURL(parentFolder).href,
						name: "parent",
					},
					{
						uri: pathToFileURL(nestedFolder).href,
						name: "nested",
					},
				],
			});

			await fs.promises.rm(tempRoot, { recursive: true, force: true });
			await fs.promises.mkdir(nestedFolder, { recursive: true });
			await fs.promises.writeFile(
				path.join(parentFolder, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD041: true,
				}),
				"utf8",
			);
			await fs.promises.writeFile(
				path.join(nestedFolder, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD041: false,
				}),
				"utf8",
			);

			try {
				await isolatedClient.start();
				await isolatedClient.openTextDocument(
					docUri,
					"Not a heading\n\n# Heading\n",
				);

				const { diagnostics } = await isolatedClient.waitForDiagnostics(docUri);
				const md041 = diagnostics.find(
					(diagnostic) => diagnostic.code === "MD041",
				);
				expect(md041).to.be.undefined;
			} finally {
				await isolatedClient.stop();
				await fs.promises.rm(tempRoot, { recursive: true, force: true });
			}
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

	describe("Code Actions", () => {
		it("should clear stale fixes when a document becomes ignored", async () => {
			const tempDir = path.join(__dirname, "fixtures", "temp-ignored-actions");
			const configPath = path.join(tempDir, ".markdownlint-cli2.jsonc");
			const docPath = path.join(tempDir, "ignored.md");
			const docUri = pathToFileURL(docPath).href;
			const content = "#No space\n";

			await fs.promises.rm(tempDir, { recursive: true, force: true });
			await fs.promises.mkdir(tempDir, { recursive: true });
			await fs.promises.writeFile(docPath, content, "utf8");

			try {
				await client.openTextDocument(docUri, content);
				let { diagnostics } = await client.waitForDiagnostics(docUri);
				expect(diagnostics.length).to.be.greaterThan(0);

				let actions = await client.requestCodeActions(
					docUri,
					diagnostics[0].range,
					diagnostics,
				);
				expect(actions.length).to.be.greaterThan(0);

				await fs.promises.writeFile(
					configPath,
					JSON.stringify({
						config: { default: true },
						ignores: ["ignored.md"],
					}),
					"utf8",
				);

				const diagnosticsPromise = client.waitForDiagnostics(docUri);
				await client.sendRawNotification("workspace/didChangeWatchedFiles", {
					changes: [
						{
							uri: pathToFileURL(configPath).href,
							type: 2,
						},
					],
				});

				({ diagnostics } = await diagnosticsPromise);
				expect(diagnostics).to.have.lengthOf(0);

				actions = await client.requestCodeActions(
					docUri,
					{
						start: { line: 0, character: 0 },
						end: { line: 0, character: 9 },
					},
					[
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 9 },
							},
							code: "MD018",
							message: "no-missing-space-atx",
							source: "markdownlint",
							severity: 2,
						},
					],
				);
				expect(actions).to.have.lengthOf(0);
			} finally {
				await client.closeTextDocument(docUri);
				await fs.promises.rm(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("Diagnostic Ranges", () => {
		it("reports diagnostic ranges after Unicode text and mixed line endings", async () => {
			const uri = createTestDocumentUri("test-ranges.md");
			const content = "# 你好 🎉\r\n\r#No space\n\nContent\n";

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
});
