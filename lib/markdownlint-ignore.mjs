import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

export const MARKDOWNLINT_IGNORE_FILENAME = ".markdownlintignore";

/**
 * Loads `.markdownlintignore` files from the given directories.
 *
 * @param {string[]} directories Directories to search, ordered from closest to
 * the file toward the workspace root.
 * @param {Function} [logger=()=>{}] Optional logger function.
 * @returns {Promise<Array<{dir: string, ignoreInstance: import("ignore").Ignore}>>}
 */
export async function loadMarkdownlintIgnoreEntries(
	directories,
	logger = () => {},
) {
	const entries = [];

	for (const dir of directories) {
		const ignorePath = path.join(dir, MARKDOWNLINT_IGNORE_FILENAME);
		try {
			const content = await fs.readFile(ignorePath, "utf8");
			const ignoreInstance = ignore().add(content);
			logger(`Found ignore file: ${ignorePath}`, true);
			entries.push({ dir, ignoreInstance });
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "EISDIR") {
				logger(`Error reading ${ignorePath}: ${error}`, true);
			}
		}
	}

	return entries;
}
