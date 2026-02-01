import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

describe("Fix All Code Actions", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should return a full-document fix-all edit", async () => {
		const uri = createTestDocumentUri("fix-all.md");
		const content = "#Heading\n\nText  ";
		await client.openTextDocument(uri, content);

		const diagnosticsParams = await client.waitForDiagnostics(uri);
		const actions = await client.requestCodeActions(
			uri,
			{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			diagnosticsParams.diagnostics,
		);

		const fixAll = actions.find((action) => action.kind === "source.fixAll");
		expect(fixAll).to.exist;
		expect(fixAll.edit).to.exist;

		const edits = fixAll.edit.changes[uri];
		expect(edits).to.have.lengthOf(1);
		expect(edits[0].newText).to.equal("# Heading\n\nText  \n");
	});
});
