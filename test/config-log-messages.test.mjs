import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

describe("Configuration log messages", function () {
	this.timeout(10000);

	let client;
	let tempDir;

	before(async () => {
		tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-logs-"),
		);
		client = new TestLanguageClient({
			rootUri: pathToFileURL(tempDir).href,
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function openDocument(directory, configName, configContent) {
		const documentDir = path.join(tempDir, directory);
		await fs.mkdir(documentDir, { recursive: true });
		if (configName) {
			await fs.writeFile(path.join(documentDir, configName), configContent);
		}
		const documentPath = path.join(documentDir, "test.md");
		const uri = pathToFileURL(documentPath).href;
		const beforeMessages = client.logMessages.length;

		await client.openTextDocument(uri, "# Heading\n");
		await client.waitForDiagnostics(uri);

		return client.logMessages.slice(beforeMessages);
	}

	it("logs the config file used at info level", async () => {
		const logs = await openDocument(
			"configured",
			".markdownlint.json",
			JSON.stringify({ MD013: false }),
		);

		expect(logs).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] using config ${path.join(tempDir, "configured", ".markdownlint.json")}`,
		});
	});

	it("logs both configs when both formats apply", async () => {
		const directory = path.join(tempDir, "both-configs");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, ".markdownlint-cli2.jsonc"),
			JSON.stringify({ MD013: false }),
		);
		await fs.writeFile(
			path.join(directory, ".markdownlint.json"),
			JSON.stringify({ MD018: false }),
		);

		const uri = pathToFileURL(path.join(directory, "test.md")).href;
		const beforeMessages = client.logMessages.length;
		await client.openTextDocument(uri, "# Heading\n");
		await client.waitForDiagnostics(uri);
		const logs = client.logMessages.slice(beforeMessages);

		expect(logs).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] using config ${path.join(tempDir, "both-configs", ".markdownlint-cli2.jsonc")}`,
		});
		expect(logs).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] using config ${path.join(tempDir, "both-configs", ".markdownlint.json")}`,
		});
	});

	it("logs when no config is found and defaults are used", async () => {
		const logs = await openDocument("unconfigured", null);

		expect(logs).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] no config found between ${path.join(tempDir, "unconfigured")} and workspace root; using defaults`,
		});
	});

	it("logs a config parse failure at warning level", async () => {
		const logs = await openDocument(
			"invalid",
			".markdownlint.json",
			"{ invalid json",
		);

		const parseFailure = logs.find(
			({ type, message }) =>
				type === 2 &&
				/failed to load or parse .*invalid[/\\]\.markdownlint\.json:/.test(
					message,
				),
		);
		expect(parseFailure).to.exist;
		expect(parseFailure.message).to.include("Unable to parse");
		expect(logs).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] no config found between ${path.join(tempDir, "invalid")} and workspace root; using defaults`,
		});
	});

	it("logs the config again after a reload", async () => {
		const directory = path.join(tempDir, "reload");
		const configPath = path.join(directory, ".markdownlint.json");
		const documentPath = path.join(directory, "test.md");
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(configPath, JSON.stringify({ MD013: false }));

		const uri = pathToFileURL(documentPath).href;
		await client.openTextDocument(uri, "# Heading\n");
		await client.waitForDiagnostics(uri);
		const beforeMessages = client.logMessages.length;

		await fs.writeFile(configPath, JSON.stringify({ MD013: true }));
		const diagnostics = client.waitForDiagnostics(uri);
		await client.sendRawNotification("workspace/didChangeWatchedFiles", {
			changes: [{ uri: pathToFileURL(configPath).href, type: 2 }],
		});
		await diagnostics;

		expect(client.logMessages.slice(beforeMessages)).to.deep.include({
			type: 3,
			message: `[markdownlint-lsp] using config ${configPath}`,
		});
	});
});
