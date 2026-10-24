import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { WorkspaceContext } from "../lib/workspace-context.mjs";

describe("WorkspaceContext configuration cache", () => {
	let root;
	let workspace;
	let originalReadFile;
	let releaseRead;
	let pendingLoad;

	beforeEach(async () => {
		root = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-cache-"),
		);
		workspace = new WorkspaceContext({
			configCacheMaxSize: 2,
			configChangeDebounceMs: 0,
		});
		workspace.initialize({ rootPath: root });
		originalReadFile = fs.readFile;
	});

	afterEach(async () => {
		fs.readFile = originalReadFile;
		releaseRead?.();
		await pendingLoad;
		releaseRead = null;
		pendingLoad = null;
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	function documentUri(directory = root, name = "doc.md") {
		return pathToFileURL(path.join(directory, name)).href;
	}

	function pauseConfigRead(configPath) {
		return new Promise((resolve, reject) => {
			fs.readFile = (file, encoding, callback) => {
				originalReadFile(file, encoding, (error, content) => {
					if (file === configPath && !releaseRead) {
						if (error) reject(error);
						releaseRead = () => {
							releaseRead = () => {};
							callback(error, content);
						};
						resolve();
					} else {
						callback(error, content);
					}
				});
			};
		});
	}

	for (const invalidation of ["clearCache", "invalidateDocumentOptions"]) {
		for (const newerLoad of [false, true]) {
			it(`${invalidation} discards an in-flight read ${newerLoad ? "after a newer load completes" : "without a replacement load"}`, async () => {
				const configPath = path.join(root, ".markdownlint.json");
				await fs.promises.writeFile(configPath, '{"MD013":false}');
				const captured = pauseConfigRead(configPath);
				pendingLoad = workspace.loadDocumentOptions(documentUri(), false);
				await captured;

				await fs.promises.writeFile(configPath, '{"MD013":true}');
				// A sibling document shares the same directory-scoped cache entry.
				workspace[invalidation](documentUri(root, "sibling.md"));
				if (newerLoad) {
					const fresh = await workspace.loadDocumentOptions(
						documentUri(),
						false,
					);
					expect(fresh.documentOptions.config.MD013).to.equal(true);
				}

				releaseRead();
				const resumed = await pendingLoad;
				const cached = await workspace.loadDocumentOptions(
					documentUri(),
					false,
				);
				expect(cached.documentOptions.config.MD013).to.equal(true);
				expect(resumed.documentOptions.config.MD013).to.equal(true);
			});
		}
	}

	it("invalidates only the target directory and preserves sibling cache sharing", async () => {
		const other = path.join(root, "other");
		await fs.promises.mkdir(other);
		const configPath = path.join(root, ".markdownlint.json");
		await fs.promises.writeFile(configPath, '{"MD013":false}');
		const captured = pauseConfigRead(configPath);
		pendingLoad = workspace.loadDocumentOptions(documentUri(), false);
		await captured;
		workspace.invalidateDocumentOptions(documentUri(other));
		await fs.promises.writeFile(configPath, '{"MD013":true}');
		releaseRead();
		const loaded = await pendingLoad;
		const sibling = await workspace.loadDocumentOptions(
			documentUri(root, "sibling.md"),
			false,
		);
		expect(loaded.documentOptions.config.MD013).to.equal(false);
		expect(sibling.documentOptions).to.equal(loaded.documentOptions);
	});

	it("retains the cache size limit and evicts the least recently used directory", async () => {
		const directories = ["first", "second", "third"].map((name) =>
			path.join(root, name),
		);
		for (const directory of directories) {
			await fs.promises.mkdir(directory);
			await fs.promises.writeFile(
				path.join(directory, ".markdownlint.json"),
				'{"MD013":false}',
			);
		}
		const [first, second, third] = directories.map((dir) => documentUri(dir));
		const initial = await workspace.loadDocumentOptions(first, false);
		await workspace.loadDocumentOptions(second, false);
		await workspace.loadDocumentOptions(first, false);
		await workspace.loadDocumentOptions(third, false);
		for (const directory of directories) {
			await fs.promises.writeFile(
				path.join(directory, ".markdownlint.json"),
				'{"MD013":true}',
			);
		}
		expect(
			(await workspace.loadDocumentOptions(first, false)).documentOptions,
		).to.equal(initial.documentOptions);
		expect(
			(await workspace.loadDocumentOptions(second, false)).documentOptions
				.config.MD013,
		).to.equal(true);
	});
});
