import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Incremental edits and large documents", function () {
	this.timeout(15000);

	let client;

	before(async () => {
		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	describe("Incremental Updates", () => {
		it("should handle line deletions", async () => {
			const uri = `file://${path.join(__dirname, "line-delete-test.md")}`;
			const initialContent = "# Heading\n\n\n\nToo many blank lines\n";

			await client.openTextDocument(uri, initialContent);
			let publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should have MD012 error for multiple blank lines
			const md012 = publishedDiagnostics.find((d) => d.code === "MD012");
			expect(md012).to.exist;

			// Delete enough blank lines to clear the rule violation
			await client.changeTextDocument(uri, 2, [
				{
					range: {
						start: { line: 2, character: 0 },
						end: { line: 4, character: 0 },
					},
					text: "",
				},
			]);

			publishedDiagnostics = await client.waitForDiagnosticsArray(uri);
			// Error should be cleared
			const newMd012 = publishedDiagnostics.find((d) => d.code === "MD012");
			expect(newMd012).to.be.undefined;
		});

		it("should handle multi-line paste operations", async () => {
			const uri = `file://${path.join(__dirname, "paste-test.md")}`;
			const initialContent = "# Document\n\n";

			await client.openTextDocument(uri, initialContent);
			await client.waitForDiagnosticsArray(uri);

			// Simulate pasting a large block of text with errors
			const pastedContent = `## Section with errors

#No space after hash

- List item
  - Wrong indentation
-No space after dash

\tHard tab line

Multiple blank lines:


End of paste
`;

			await client.changeTextDocument(uri, 2, [
				{
					range: {
						start: { line: 2, character: 0 },
						end: { line: 2, character: 0 },
					},
					text: pastedContent,
				},
			]);

			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should detect multiple errors in the pasted content
			expect(publishedDiagnostics.length).to.be.at.least(3);

			const errorCodes = publishedDiagnostics.map((d) => d.code);
			expect(errorCodes).to.include("MD018"); // no-missing-space-atx
			expect(errorCodes).to.include("MD010"); // no-hard-tabs
			expect(errorCodes).to.include("MD012"); // no-multiple-blanks
		});
	});

	describe("Large Documents", () => {
		it("should handle documents with many headings", async () => {
			const uri = `file://${path.join(__dirname, "many-headings-test.md")}`;
			let content = "# Main Document\n\n";

			// Generate 500 sections with potential duplicate headings
			for (let i = 0; i < 500; i++) {
				content += `## Section ${i % 50}\n\nContent for section ${i}.\n\n`;
			}

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should detect duplicate headings
			const md024 = publishedDiagnostics.filter((d) => d.code === "MD024");
			expect(md024.length).to.be.greaterThan(0);
		});
	});
});
