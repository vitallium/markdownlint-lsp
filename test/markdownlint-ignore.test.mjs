import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import ignore from "ignore";
import { after, before, describe, it } from "mocha";
import {
	isIgnoredByMarkdownlintIgnore,
	loadMarkdownlintIgnoreEntries,
} from "../lib/markdownlint-ignore.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("markdownlint-ignore", () => {
	const baseDir = path.join(__dirname, "fixtures", "temp-markdownlintignore");

	before(async () => {
		await fs.rm(baseDir, { recursive: true, force: true });
		await fs.mkdir(path.join(baseDir, "nested"), { recursive: true });
		await fs.writeFile(path.join(baseDir, ".markdownlintignore"), "root.md\n");
		await fs.writeFile(
			path.join(baseDir, "nested", ".markdownlintignore"),
			"nested.md\n",
		);
	});

	after(async () => {
		await fs.rm(baseDir, { recursive: true, force: true });
	});

	it("should match gitignore-style patterns relative to the ignore file", () => {
		const ignoreEntries = [
			{
				dir: baseDir,
				ignoreInstance: ignore().add("generated/\nCHANGELOG.md\n"),
			},
		];

		expect(
			isIgnoredByMarkdownlintIgnore(
				path.join(baseDir, "generated", "notes.md"),
				ignoreEntries,
			),
		).to.equal(true);
		expect(
			isIgnoredByMarkdownlintIgnore(
				path.join(baseDir, "README.md"),
				ignoreEntries,
			),
		).to.equal(false);
	});

	it("should load ignore entries from directories on the search path", async () => {
		const nestedDir = path.join(baseDir, "nested");
		const entries = await loadMarkdownlintIgnoreEntries([nestedDir, baseDir]);
		expect(entries).to.have.length(2);
		expect(entries[0].dir).to.equal(nestedDir);
		expect(entries[1].dir).to.equal(baseDir);
	});
});
