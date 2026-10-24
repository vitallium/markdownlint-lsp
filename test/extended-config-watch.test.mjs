import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { loadConfig } from "../lib/config.mjs";
import { WorkspaceContext } from "../lib/workspace-context.mjs";
import { TestLanguageClient } from "./helpers.mjs";

describe("Extended configuration watchers", function () {
	this.timeout(10000);
	let tempDir;
	let root;
	let client;
	let uri;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdownlint-extends-"));
		root = path.join(tempDir, "workspace");
		await fs.mkdir(root);
		uri = pathToFileURL(path.join(root, "test.md")).href;
	});

	afterEach(async () => {
		await client?.stop();
		client = null;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function start(dynamicRegistration = true) {
		client = new TestLanguageClient({
			rootUri: pathToFileURL(root).href,
			capabilities: {
				workspace: { didChangeWatchedFiles: { dynamicRegistration } },
			},
		});
		await client.start();
	}

	async function open() {
		const report = client.waitForDiagnostics(uri);
		await client.openTextDocument(uri, "# Heading\n\nTrailing spaces    \n");
		return (await report).diagnostics.map(({ code }) => code);
	}

	async function change(file, content, type = 2) {
		// A real client only delivers events covered by an active registration.
		expect(client.isWatched(file), `watch coverage for ${file}`).to.equal(true);
		if (content === null) await fs.unlink(file);
		else await fs.writeFile(file, content);
		const report = client.waitForDiagnostics(uri);
		await client.sendRawNotification("workspace/didChangeWatchedFiles", {
			changes: [{ uri: pathToFileURL(file).href, type }],
		});
		return (await report).diagnostics.map(({ code }) => code);
	}

	it("registers extends files and refreshes cached diagnostics on edit, delete and recreate", async () => {
		const rules = path.join(root, "rules.yaml");
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "./rules.yaml" }),
		);
		await fs.writeFile(rules, "MD009: false\n");
		await start();
		expect(await open()).not.to.include("MD009");
		expect(await change(rules, "MD009: true\n")).to.include("MD009");
		expect(await change(rules, null, 3)).to.include("MD009");
		expect(await change(rules, "MD009: false\n", 1)).not.to.include("MD009");
		expect(client.isWatched(path.join(root, "unrelated.yaml"))).to.equal(false);
	});

	it("watches transitive package and outside-root dependencies with literal glob characters", async () => {
		const packageDir = path.join(root, "node_modules", "shared-rules");
		await fs.mkdir(packageDir, { recursive: true });
		await fs.writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ main: "rules.json" }),
		);
		const packageRules = path.join(packageDir, "rules.json");
		const outsideRules = path.join(tempDir, "rules[shared]{x}*.yaml");
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "shared-rules" }),
		);
		await fs.writeFile(packageRules, JSON.stringify({ extends: outsideRules }));
		await fs.writeFile(outsideRules, "MD009: false\n");
		await start();
		expect(await open()).not.to.include("MD009");
		// Node's package resolver canonicalizes symlinks (including macOS /var).
		expect(client.isWatched(await fs.realpath(packageRules))).to.equal(true);
		expect(await change(outsideRules, "MD009: true\n")).to.include("MD009");
		expect(
			await change(
				await fs.realpath(packageRules),
				JSON.stringify({ MD009: false }),
			),
		).not.to.include("MD009");
		await client.waitForWatchers(() => !client.isWatched(outsideRules));
		expect(
			client.isWatched(path.join(tempDir, "rulessxanything.yaml")),
		).to.equal(false);
	});

	it("does not register watchers without dynamic registration support", async () => {
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "./rules.yaml" }),
		);
		await fs.writeFile(path.join(root, "rules.yaml"), "MD009: false\n");
		await start(false);
		expect(await open()).not.to.include("MD009");
		expect(client.registrationRequests).to.have.lengthOf(0);
	});

	it("deduplicates shared dependencies and releases replaced and closed-document watches", async () => {
		const config = path.join(root, ".markdownlint.json");
		const rules = path.join(root, "rules.yaml");
		const replacement = path.join(root, "replacement.yaml");
		await fs.writeFile(config, JSON.stringify({ extends: "./rules.yaml" }));
		await fs.writeFile(rules, "MD009: false\n");
		await fs.writeFile(replacement, "MD009: true\n");
		await start();
		expect(await open()).not.to.include("MD009");
		const otherUri = pathToFileURL(path.join(root, "other.md")).href;
		const report = client.waitForDiagnostics(otherUri);
		await client.openTextDocument(otherUri, "# Heading\n");
		await report;
		// One conventional registration and one dependency registration, even on cache hits.
		expect(client.registrationRequests).to.have.lengthOf(2);
		expect(client.registrations).to.have.lengthOf(2);

		await change(config, JSON.stringify({ extends: "./replacement.yaml" }));
		await client.waitForWatchers(() => !client.isWatched(rules));
		expect(client.isWatched(replacement)).to.equal(true);
		expect(client.registrations).to.have.lengthOf(2);

		const closed = client.waitForDiagnostics(uri);
		await client.closeTextDocument(uri);
		await closed;
		expect(client.isWatched(replacement)).to.equal(true);
		await client.closeTextDocument(otherUri);
		await client.waitForWatchers(() => !client.isWatched(replacement));
		expect(client.registrations).to.have.lengthOf(1);
	});

	it("recomputes dependencies when workspace folders change", async () => {
		const rules = path.join(root, "rules.yaml");
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "./rules.yaml" }),
		);
		await fs.writeFile(rules, "MD009: false\n");
		await start();
		expect(await open()).not.to.include("MD009");
		expect(client.isWatched(rules)).to.equal(true);
		const report = client.waitForDiagnostics(uri);
		await client.sendRawNotification("workspace/didChangeWorkspaceFolders", {
			event: {
				removed: [{ uri: pathToFileURL(root).href, name: "old" }],
				added: [{ uri: pathToFileURL(tempDir).href, name: "parent" }],
			},
		});
		await report;
		// The document still inherits its config after switching to the parent workspace.
		expect(client.isWatched(rules)).to.equal(true);
		const nextReport = client.waitForDiagnostics(uri);
		await client.sendRawNotification("workspace/didChangeWorkspaceFolders", {
			event: {
				removed: [{ uri: pathToFileURL(tempDir).href, name: "parent" }],
				added: [],
			},
		});
		expect((await nextReport).diagnostics.map(({ code }) => code)).to.include(
			"MD009",
		);
		await client.waitForWatchers(() => !client.isWatched(rules));
	});

	it("keeps dependency tracking separate from public options and cached lint options", async () => {
		const rules = path.join(root, "rules.yaml");
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "./rules.yaml" }),
		);
		await fs.writeFile(rules, "MD009: false\n");
		const dependencies = [];
		expect(
			await loadConfig(uri, root, {
				onConfigDependency: (file) => dependencies.push(file),
			}),
		).to.deep.equal({ config: { MD009: false } });
		expect(dependencies).to.deep.equal([rules]);
		const workspace = new WorkspaceContext({
			configCacheMaxSize: 1,
			configChangeDebounceMs: 0,
		});
		workspace.initialize({ rootPath: root });
		const loaded = await workspace.loadDocumentOptions(uri, false);
		const cached = await workspace.loadDocumentOptions(uri, false);
		expect(cached).to.deep.equal(loaded);
		expect([...cached.configDependencies]).to.deep.equal([rules]);
		expect(cached.documentOptions).to.deep.equal({ config: { MD009: false } });
	});

	it("reloads dependencies changed while their documents were closed", async () => {
		const rules = path.join(root, "rules.yaml");
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			JSON.stringify({ extends: "./rules.yaml" }),
		);
		await fs.writeFile(rules, "MD009: false\n");
		await start();
		expect(await open()).not.to.include("MD009");
		const closed = client.waitForDiagnostics(uri);
		await client.closeTextDocument(uri);
		await closed;
		await client.waitForWatchers(() => !client.isWatched(rules));
		await fs.writeFile(rules, "MD009: true\n");
		expect(await open()).to.include("MD009");
	});
});
