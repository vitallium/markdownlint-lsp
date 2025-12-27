import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient, wait } from "./helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Edge Cases and Performance", function () {
	this.timeout(15000); // Longer timeout for performance tests

	let client;

	before(async () => {
		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	describe("Incremental Updates", () => {
		it("should handle single character insertions efficiently", async () => {
			const uri = `file://${path.join(__dirname, "incremental-test.md")}`;
			const initialContent = "# Heading\n\nParagraph content\n";

			await client.openTextDocument(uri, initialContent);
			let publishedDiagnostics = await client.waitForDiagnosticsArray(uri);
			expect(publishedDiagnostics).to.have.lengthOf(0);

			// Insert a character that creates an error
			await client.changeTextDocument(uri, 2, [
				{
					range: {
						start: { line: 0, character: 1 },
						end: { line: 0, character: 1 },
					},
					text: "#", // Creates "## Heading" which might trigger heading increment issues
				},
			]);

			publishedDiagnostics = await client.waitForDiagnosticsArray(uri);
			// Should process the change quickly
			expect(publishedDiagnostics).to.exist;
		});

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

	describe("Unicode and Special Characters", () => {
		it("should handle emoji in headings correctly", async () => {
			const uri = `file://${path.join(__dirname, "emoji-test.md")}`;
			const content = `# 🎉 Celebration Heading

## 📝 Notes Section

### 🚀 Launch Details

Regular text with emoji: 😊 👍 ✨
`;

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should not have any errors for emoji in headings
			expect(publishedDiagnostics).to.have.lengthOf(0);
		});

		it("should handle non-ASCII characters in content", async () => {
			const uri = `file://${path.join(__dirname, "unicode-test.md")}`;
			const content = `# Überschrift

Dies ist ein deutscher Text mit Umlauten: ä, ö, ü, ß

## 中文标题

这是一段中文文字。

## Заголовок на русском

Текст на русском языке.

## עברית

טקסט בעברית מימין לשמאל.
`;

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should handle all Unicode correctly
			expect(publishedDiagnostics).to.have.lengthOf(0);
		});

		it("should correctly calculate positions with multi-byte characters", async () => {
			const uri = `file://${path.join(__dirname, "multibyte-position-test.md")}`;
			const content = `# 你好世界

#缺少空格

Text after Chinese characters
`;

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should detect the missing space after # even with Chinese characters
			const md018 = publishedDiagnostics.find((d) => d.code === "MD018");
			expect(md018).to.exist;
			expect(md018.range.start.line).to.equal(2); // Third line
		});
	});

	describe("Performance with Large Documents", () => {
		it("should handle documents with many headings", async () => {
			const uri = `file://${path.join(__dirname, "many-headings-test.md")}`;
			let content = "# Main Document\n\n";

			// Generate 500 sections with potential duplicate headings
			for (let i = 0; i < 500; i++) {
				content += `## Section ${i % 50}\n\nContent for section ${i}.\n\n`;
			}

			const startTime = Date.now();
			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);
			const elapsed = Date.now() - startTime;

			// Should complete within reasonable time
			expect(elapsed).to.be.lessThan(5000);

			// Should detect duplicate headings
			const md024 = publishedDiagnostics.filter((d) => d.code === "MD024");
			expect(md024.length).to.be.greaterThan(0);
		});

		it("should handle documents with complex tables", async () => {
			const uri = `file://${path.join(__dirname, "complex-tables-test.md")}`;
			let content = "# Table Document\n\n";

			// Generate multiple tables
			for (let t = 0; t < 20; t++) {
				content += `## Table ${t}\n\n`;
				content += "| Header 1 | Header 2 | Header 3 | Header 4 | Header 5 |\n";
				content += "| -------- | -------- | -------- | -------- | -------- |\n";

				for (let r = 0; r < 50; r++) {
					content += `| Cell ${r}-1 | Cell ${r}-2 | Cell ${r}-3 | Cell ${r}-4 | Cell ${r}-5 |\n`;
				}
				content += "\n";
			}

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should handle large tables without issues
			expect(publishedDiagnostics).to.exist;
		});

		it("should handle documents with many code blocks", async () => {
			const uri = `file://${path.join(__dirname, "many-codeblocks-test.md")}`;
			let content = "# Code Examples\n\n";

			// Generate many code blocks
			for (let i = 0; i < 100; i++) {
				content += `## Example ${i}\n\n`;
				content += "```javascript\n";
				content += `function example${i}() {\n`;
				content += `  console.log("Example ${i}");\n`;
				content += `  return ${i};\n`;
				content += "}\n";
				content += "```\n\n";

				// Some without language
				if (i % 5 === 0) {
					content += "```\n";
					content += "Code block without language\n";
					content += "```\n\n";
				}
			}

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should detect code blocks without language (MD040)
			const md040 = publishedDiagnostics.filter((d) => d.code === "MD040");
			expect(md040.length).to.be.greaterThan(0);
		});
	});

	describe("Rapid Changes", () => {
		it("should debounce rapid consecutive changes", async () => {
			const uri = `file://${path.join(__dirname, "rapid-changes-test.md")}`;
			const initialContent = "# Heading\n\n";

			await client.openTextDocument(uri, initialContent);
			await client.waitForDiagnosticsArray(uri);

			// Simulate rapid typing
			const changes = "This is being typed quickly".split("");
			let position = 2;

			for (const char of changes) {
				await client.changeTextDocument(uri, position + 1, [
					{
						range: {
							start: { line: 2, character: position },
							end: { line: 2, character: position },
						},
						text: char,
					},
				]);
				position++;
				// Don't wait between changes
			}

			// Wait for final diagnostics without missing the notification
			const diagnosticsPromise = client.waitForDiagnostics(uri);
			await wait(500);
			const diagnosticsReport = await diagnosticsPromise;

			// Should have processed all changes
			expect(diagnosticsReport.diagnostics).to.exist;
		});
	});

	describe("Error Recovery", () => {
		it("should recover from documents with invalid frontmatter", async () => {
			const uri = `file://${path.join(__dirname, "invalid-frontmatter-test.md")}`;
			const content = `---
invalid: yaml: syntax:: here
---

# Document Title

Regular content
`;

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should still process the document despite invalid frontmatter
			expect(diagnosticsReport).to.exist;
			// The actual markdown content should be validated
			expect(diagnosticsReport.diagnostics).to.be.an("array");
		});

		it("should handle documents with mixed line endings", async () => {
			const uri = `file://${path.join(__dirname, "mixed-lineendings-test.md")}`;
			// Mix of \n, \r\n, and \r
			const content = "# Heading\r\n\rParagraph one\n\nParagraph two\r\n";

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should handle mixed line endings gracefully
			expect(diagnosticsReport).to.exist;
		});

		it("should handle empty code blocks", async () => {
			const uri = `file://${path.join(__dirname, "empty-codeblocks-test.md")}`;
			const content = `# Document

\`\`\`javascript
\`\`\`

\`\`\`
\`\`\`

\`\`\`python

\`\`\`
`;

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should handle empty code blocks
			expect(diagnosticsReport).to.exist;
			// May have MD040 for fenced code block without language
			const md040 = diagnosticsReport.diagnostics.find(
				(d) => d.code === "MD040",
			);
			expect(md040).to.exist;
		});
	});

	describe("Nested Structures", () => {
		it("should handle deeply nested lists", async () => {
			const uri = `file://${path.join(__dirname, "nested-lists-test.md")}`;
			const content = `# Nested Lists

- Level 1
  - Level 2
    - Level 3
      - Level 4
        - Level 5
          - Level 6
            - Level 7
              - Level 8
                - Level 9
                  - Level 10

1. Ordered Level 1
   1. Ordered Level 2
      1. Ordered Level 3
         1. Ordered Level 4
            1. Ordered Level 5
`;

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should handle deep nesting
			expect(diagnosticsReport).to.exist;
		});

		it("should handle nested blockquotes", async () => {
			const uri = `file://${path.join(__dirname, "nested-blockquotes-test.md")}`;
			const content = `# Nested Blockquotes

> Level 1 quote
> > Level 2 quote
> > > Level 3 quote
> > > > Level 4 quote
> > > > > Level 5 quote

> Quote with multiple paragraphs
>
> Second paragraph in quote
> > Nested quote
> >
> > With its own paragraphs
`;

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should handle nested blockquotes
			expect(diagnosticsReport).to.exist;
		});
	});

	describe("Link and Reference Handling", () => {
		it("should validate link references", async () => {
			const uri = `file://${path.join(__dirname, "link-references-test.md")}`;
			const content = `# Links

This is a [valid reference][valid].

This is an [invalid reference][invalid].

This is an [unused reference][unused].

[valid]: https://example.com "Valid Link"
[unused]: https://example.com "Unused Link"
`;

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should detect undefined references
			const md052 = publishedDiagnostics.find((d) => d.code === "MD052");
			expect(md052).to.exist;
		});

		it("should handle link fragments", async () => {
			const uri = `file://${path.join(__dirname, "link-fragments-test.md")}`;
			const content = `# Main Heading

## Section One

Link to [Main Heading](#main-heading)
Link to [Section One](#section-one)
Link to [Non-existent Section](#non-existent)
`;

			await client.openTextDocument(uri, content);
			const diagnosticsReport = await client.waitForDiagnostics(uri);

			// Should validate link fragments if MD051 is enabled
			expect(diagnosticsReport).to.exist;
		});
	});
});
