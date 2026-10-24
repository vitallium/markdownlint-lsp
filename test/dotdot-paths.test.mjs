import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { loadConfig } from "../lib/config.mjs";
import { IgnorePatternSet } from "../lib/ignore-pattern-set.mjs";
import { loadMarkdownlintIgnoreEntries } from "../lib/markdownlint-ignore.mjs";
import { WorkspaceContext } from "../lib/workspace-context.mjs";

describe("Directories starting with two dots", () => {
	let root;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "markdownlint-dotdot-"));
		await fs.mkdir(path.join(root, "..drafts"));
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("loads ancestor configuration without searching outside the workspace", async () => {
		await fs.writeFile(
			path.join(root, ".markdownlint.json"),
			'{"MD013":false}',
		);
		const inside = pathToFileURL(path.join(root, "..drafts", "a.md")).href;
		expect(await loadConfig(inside, root)).to.deep.equal({
			config: { MD013: false },
		});
		const outside = pathToFileURL(path.join(root, "..", "outside.md")).href;
		expect(await loadConfig(outside, root)).to.equal(null);
	});

	it("selects the matching workspace rather than falling back to the first root", () => {
		const first = path.join(root, "first");
		const workspace = new WorkspaceContext({
			configCacheMaxSize: 2,
			configChangeDebounceMs: 0,
		});
		workspace.initialize({
			rootPath: first,
			workspaceFolders: [
				{ uri: pathToFileURL(first).href, name: "first" },
				{ uri: pathToFileURL(root).href, name: "second" },
			],
		});
		expect(
			workspace.getWorkspaceRootFor(
				pathToFileURL(path.join(root, "..drafts", "a.md")).href,
			),
		).to.equal(root);
		expect(
			workspace.getWorkspaceRootFor(
				pathToFileURL(path.join(root, "..", "outside.md")).href,
			),
		).to.equal(first);
	});

	it("applies ignore files to two-dot names but not to parent directories", async () => {
		await fs.writeFile(path.join(root, ".markdownlintignore"), "*.md\n");
		const patterns = new IgnorePatternSet({
			markdownlintIgnoreEntries: await loadMarkdownlintIgnoreEntries([root]),
		});
		expect(patterns.matches(path.join(root, "..drafts", "a.md"))).to.equal(
			true,
		);
		expect(patterns.matches(path.join(root, "..draft.md"))).to.equal(true);
		expect(patterns.matches(path.join(root, "..", "outside.md"))).to.equal(
			false,
		);
	});
});
