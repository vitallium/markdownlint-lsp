import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

const range = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 5 },
};

describe("Code action document versions", () => {
	for (const reopen of [false, true]) {
		it(`discards in-flight results after ${reopen ? "close/reopen" : "a change"}`, async () => {
			const directory = await fs.mkdtemp(
				path.join(os.tmpdir(), "markdownlint-stale-actions-"),
			);
			const started = path.join(directory, "started");
			const release = path.join(directory, "release");
			await fs.writeFile(
				path.join(directory, ".markdownlint.mjs"),
				`import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
await fs.writeFile(${JSON.stringify(started)}, "");
while (true) {
	try { await fs.access(${JSON.stringify(release)}); break; }
	catch { await delay(10); }
}
export default { default: false, MD018: true };
`,
			);
			const client = new TestLanguageClient({
				rootUri: pathToFileURL(directory).href,
				capabilities: { workspace: { configuration: false } },
				initializationOptions: {
					allowJavaScriptConfig: true,
					config: { default: false, MD018: true },
				},
			});
			const uri = pathToFileURL(path.join(directory, "test.md")).href;
			const reports = [];
			try {
				const rawClient = await client.start();
				rawClient.onNotification(
					"textDocument/publishDiagnostics",
					(report) => {
						if (report.uri === uri) reports.push(report);
					},
				);
				await client.openTextDocument(uri, "#Bad\n");
				const deadline = Date.now() + 4000;
				while (true) {
					try {
						await fs.access(started);
						break;
					} catch {
						if (Date.now() > deadline) throw new Error("Config did not load");
						await delay(10);
					}
				}
				if (reopen) {
					await client.closeTextDocument(uri);
					await client.openTextDocument(uri, "hello\n");
				} else {
					await client.changeTextDocument(uri, 2, [{ text: "hello\n" }]);
				}
				// The request is a barrier: the server has processed the lifecycle
				// notifications before the blocked configuration import is released.
				expect(await client.requestCodeActions(uri, range)).to.deep.equal([]);
				const nextReport = client.waitForDiagnostics(uri);
				await fs.writeFile(release, "");
				const report = await nextReport;
				expect(report.version).to.equal(reopen ? 1 : 2);
				expect(report.diagnostics).to.deep.equal([]);
				expect(await client.requestCodeActions(uri, range)).to.deep.equal([]);
				expect(reports.every((item) => item.diagnostics.length === 0)).to.equal(
					true,
				);
			} finally {
				await client.stop();
				await fs.rm(directory, { recursive: true, force: true });
			}
		});
	}

	it("does not offer old quick fixes or Fix All during delayed validation", async () => {
		const client = new TestLanguageClient({
			initializationOptions: { validationDelay: 1000 },
		});
		const uri = createTestDocumentUri("stale-code-actions.md");
		try {
			await client.start();
			await client.openTextDocument(uri, "#Bad\n");
			const { diagnostics } = await client.waitForDiagnostics(uri);
			const initialActions = await client.requestCodeActions(
				uri,
				range,
				diagnostics,
			);
			expect(initialActions.map((action) => action.kind)).to.include.members([
				"quickfix",
				"source.fixAll",
			]);

			await client.changeTextDocument(uri, 2, [{ text: "hello\n" }]);
			const actions = await client.requestCodeActions(uri, range, diagnostics);
			expect(actions).to.deep.equal([]);
			expect(await client.requestCodeActions(uri, range)).to.deep.equal([]);

			const report = await client.waitForDiagnostics(uri);
			expect(report.version).to.equal(2);
			expect(await client.requestCodeActions(uri, range)).to.deep.equal([]);

			await client.changeTextDocument(uri, 3, [{ text: "#New\n" }]);
			const updated = await client.waitForDiagnostics(uri);
			expect(updated.version).to.equal(3);
			expect(
				await client.requestCodeActions(uri, range, updated.diagnostics),
			).to.have.length.greaterThan(0);
		} finally {
			await client.stop();
		}
	});

	for (const documentChanges of [true, false, undefined]) {
		it(`uses compatible edits with documentChanges=${documentChanges}`, async () => {
			const client = new TestLanguageClient({
				capabilities: {
					workspace: { workspaceEdit: { documentChanges } },
				},
			});
			const uri = createTestDocumentUri("versioned-code-actions.md");
			try {
				await client.start();
				await client.openTextDocument(uri, "#Bad\n");
				const { diagnostics } = await client.waitForDiagnostics(uri);
				const actions = await client.requestCodeActions(
					uri,
					range,
					diagnostics,
				);
				expect(actions.map((action) => action.kind)).to.include.members([
					"quickfix",
					"source.fixAll",
				]);
				for (const action of actions) {
					if (documentChanges) {
						expect(action.edit).not.to.have.property("changes");
						expect(action.edit.documentChanges).to.have.lengthOf(1);
						const [change] = action.edit.documentChanges;
						expect(change.textDocument).to.deep.equal({ uri, version: 1 });
						expect(
							TextDocument.applyEdits(
								TextDocument.create(uri, "markdown", 1, "#Bad\n"),
								change.edits,
							),
						).to.equal("# Bad\n");
					} else {
						expect(action.edit).not.to.have.property("documentChanges");
						expect(action.edit.changes[uri]).to.have.lengthOf(1);
					}
				}
				await client.changeTextDocument(uri, 2, [{ text: "hello\n" }]);
				// Already-returned versioned edits retain their original version so
				// supporting clients can reject them after the document changes.
				if (documentChanges) {
					for (const action of actions) {
						expect(
							action.edit.documentChanges[0].textDocument.version,
						).to.equal(1);
					}
				}
			} finally {
				await client.stop();
			}
		});
	}
});
