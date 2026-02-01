import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

describe("Initialization Settings", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient({
			initializationOptions: {
				noInlineConfig: true,
			},
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should honor noInlineConfig from initialization options", async () => {
		const uri = createTestDocumentUri("inline-config.md");
		const content = `<!-- markdownlint-disable MD013 -->
This is a very long line that should trigger MD013 even though the inline config attempts to disable it.
`;

		await client.openTextDocument(uri, content);
		const diagnostics = await client.waitForDiagnosticsArray(uri);

		const md013 = diagnostics.find((diagnostic) => diagnostic.code === "MD013");
		expect(md013).to.exist;
	});
});
