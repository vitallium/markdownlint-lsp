import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

describe("Watcher registration", function () {
	this.timeout(10000);
	let tempDir;
	let client;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownlint-watch-"));
	});

	afterEach(async () => {
		await client?.stop();
		client = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function startClient(options) {
		client = new TestLanguageClient({
			capabilities: {
				workspace: {
					didChangeWatchedFiles: {
						dynamicRegistration: true,
					},
				},
			},
			...options,
		});
		await client.start();
	}

	it("watches package.json only at each workspace folder root", async () => {
		const rootA = path.join(tempDir, "workspace-a");
		const rootB = path.join(tempDir, "workspace-b");
		await fs.mkdir(rootA);
		await fs.mkdir(rootB);
		await startClient({
			rootUri: pathToFileURL(rootA).href,
			workspaceFolders: [
				{ uri: pathToFileURL(rootA).href, name: "workspace-a" },
				{ uri: pathToFileURL(rootB).href, name: "workspace-b" },
			],
		});
		// The initial registration request arrives after initialization.
		await client.waitForWatchers(() =>
			client.registrations.some(({ registerOptions }) =>
				registerOptions.watchers.some(
					({ globPattern }) => globPattern === "package.json",
				),
			),
		);
		const watchers = client.registrations.flatMap(
			({ registerOptions }) => registerOptions.watchers,
		);
		expect(watchers).to.deep.include({ globPattern: "package.json" });
		expect(watchers).not.to.deep.include({ globPattern: "**/package.json" });
		// String globs are evaluated per workspace folder, so both roots are
		// covered without watching nested package.json files (for example
		// under node_modules during an install).
		expect(client.isWatched(path.join(rootA, "package.json"))).to.equal(true);
		expect(client.isWatched(path.join(rootB, "package.json"))).to.equal(true);
		expect(
			client.isWatched(path.join(rootA, "node_modules", "pkg", "package.json")),
		).to.equal(false);
		// Root-level markdownlint configuration files stay covered by the
		// remaining `**/` globs.
		expect(client.isWatched(path.join(rootB, ".markdownlint.json"))).to.equal(
			true,
		);
	});

	it("keeps linting when the client rejects watcher registration", async () => {
		const root = path.join(tempDir, "workspace");
		await fs.mkdir(root);
		await startClient({
			rootUri: pathToFileURL(root).href,
			failRegistrationRequests: true,
		});
		// The rejected client/registerCapability request is logged as a
		// warning instead of escaping as an unhandled rejection.
		await until(() =>
			client.logMessages.some(({ message }) =>
				message.includes("Unable to register configuration file watchers"),
			),
		);
		expect(client.registrationRequests).to.have.lengthOf(1);
		expect(client.registrations).to.have.lengthOf(0);
		// The server survived the rejection and still lints documents.
		const uri = pathToFileURL(path.join(root, "doc.md")).href;
		const report = client.waitForDiagnostics(uri);
		await client.openTextDocument(uri, "#No space\n");
		const { diagnostics } = await report;
		expect(diagnostics).to.have.lengthOf.at.least(1);
	});
});

async function until(predicate, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
