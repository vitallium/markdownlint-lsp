import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

describe("Validation Queue", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient({
			capabilities: { workspace: { configuration: false } },
			initializationOptions: { validationDelay: 100 },
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should publish diagnostics for the latest change", async () => {
		const uri = createTestDocumentUri("validation-queue.md");
		await client.openTextDocument(uri, "# Heading\n");
		await client.waitForDiagnostics(uri);

		const latest = client.waitForDiagnostics(uri);
		await Promise.all([
			client.changeTextDocument(uri, 2, [{ text: "# With space\n" }]),
			client.changeTextDocument(uri, 3, [{ text: "#No space\n" }]),
		]);

		const { diagnostics, version } = await latest;
		expect(version).to.equal(3);
		expect(
			diagnostics.some((diagnostic) => diagnostic.code === "MD018"),
		).to.equal(true);
	});
});
