import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { IgnorePatternSet } from "../lib/ignore-pattern-set.mjs";
import { loadMarkdownlintIgnoreEntries } from "../lib/markdownlint-ignore.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("markdownlint-ignore", () => {
	const baseDir = path.join(__dirname, "fixtures", "temp-markdownlintignore");

	before(async () => {
		await fs.rm(baseDir, { recursive: true, force: true });
		await fs.mkdir(path.join(baseDir, "nested"), { recursive: true });
		await fs.writeFile(
			path.join(baseDir, ".markdownlintignore"),
			"generated/\nCHANGELOG.md\n",
		);
		await fs.writeFile(
			path.join(baseDir, "nested", ".markdownlintignore"),
			"nested.md\n",
		);
	});

	after(async () => {
		await fs.rm(baseDir, { recursive: true, force: true });
	});

	it("should match gitignore-style patterns relative to the ignore file", async () => {
		const ignoreEntries = await loadMarkdownlintIgnoreEntries([baseDir]);
		const ignorePatternSet = new IgnorePatternSet({
			markdownlintIgnoreEntries: ignoreEntries,
			workspaceRoot: baseDir,
		});

		expect(
			ignorePatternSet.matches(
				path.join(baseDir, "generated", "notes.md"),
				baseDir,
			),
		).to.equal(true);
		expect(
			ignorePatternSet.matches(path.join(baseDir, "README.md"), baseDir),
		).to.equal(false);
	});

	for (const [name, parent, child, filename, expected] of [
		["child file exception", "*.md\n", "!keep.md\n", "nested/keep.md", false],
		["unmatched child rule", "*.md\n", "!keep.md\n", "nested/other.md", true],
		[
			"excluded parent directory",
			"nested/\n",
			"!keep.md\n",
			"nested/keep.md",
			true,
		],
		[
			"child directory exception",
			"nested/*\n",
			"!sub/\n",
			"nested/sub/keep.md",
			false,
		],
		["child positive rule", "", "*.md\n", "nested/sub/other.md", true],
		["root anchored child rule", "", "/keep.md\n", "nested/sub/keep.md", false],
		["root anchored child match", "", "/keep.md\n", "nested/keep.md", true],
		["scoped path match", "", "sub/keep.md\n", "nested/sub/keep.md", true],
		[
			"scoped path non-match",
			"",
			"sub/keep.md\n",
			"nested/other/sub/keep.md",
			false,
		],
		["sibling scope", "", "*.md\n", "sibling/keep.md", false],
		[
			"blank lines and comments",
			"",
			"\n   \n# comment\n",
			"nested/sub/keep.md",
			false,
		],
		[
			"escaped leading exclamation",
			"",
			"\\!keep.md\n",
			"nested/!keep.md",
			true,
		],
		["escaped leading hash", "", "\\#keep.md\n", "nested/#keep.md", true],
	]) {
		it(`honors ${name}`, async () => {
			const root = await fs.mkdtemp(
				path.join(os.tmpdir(), "markdownlint-ignore-"),
			);
			try {
				const nested = path.join(root, "nested");
				await fs.mkdir(nested);
				await fs.writeFile(path.join(root, ".markdownlintignore"), parent);
				await fs.writeFile(path.join(nested, ".markdownlintignore"), child);
				const patterns = new IgnorePatternSet({
					markdownlintIgnoreEntries: await loadMarkdownlintIgnoreEntries([
						nested,
						root,
					]),
				});
				expect(patterns.matches(path.join(root, filename))).to.equal(expected);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}

	it("treats glob characters in an ignore file's directory as literal", async () => {
		const nested = path.join(baseDir, "docs[1]");
		await fs.mkdir(nested);
		await fs.writeFile(path.join(nested, ".markdownlintignore"), "keep.md\n");
		const patterns = new IgnorePatternSet({
			markdownlintIgnoreEntries: await loadMarkdownlintIgnoreEntries([
				nested,
				baseDir,
			]),
		});
		expect(patterns.matches(path.join(nested, "keep.md"))).to.equal(true);
		expect(patterns.matches(path.join(baseDir, "docs1", "keep.md"))).to.equal(
			false,
		);
	});
});
