import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

describe("Validation Queue", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should publish diagnostics for the latest change", async () => {
		const uri = createTestDocumentUri("validation-queue.md");
		await client.openTextDocument(uri, "#No space\n");
		await client.waitForDiagnostics(uri);

		await client.changeTextDocument(uri, 2, [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 9 },
				},
				text: "# With space",
			},
		]);

		await client.changeTextDocument(uri, 3, [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 12 },
				},
				text: "#No space",
			},
		]);

		const { diagnostics } = await client.waitForDiagnostics(uri);
		expect(
			diagnostics.some((diagnostic) => diagnostic.code === "MD018"),
		).to.equal(true);
	});
});
