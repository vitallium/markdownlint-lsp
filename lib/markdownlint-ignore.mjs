import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

export const MARKDOWNLINT_IGNORE_FILENAME = ".markdownlintignore";

function toPosixPath(filePath) {
	return filePath.split(path.sep).join("/");
}

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

/**
 * Returns whether a file path is ignored by any ancestor `.markdownlintignore`
 * file, using gitignore-style rules relative to each ignore file's directory.
 *
 * @param {string} filePath Absolute path to the file being validated.
 * @param {Array<{dir: string, ignoreInstance: import("ignore").Ignore}>} ignoreEntries
 * @returns {boolean}
 */
export function isIgnoredByMarkdownlintIgnore(filePath, ignoreEntries) {
	if (!Array.isArray(ignoreEntries) || ignoreEntries.length === 0) {
		return false;
	}

	return ignoreEntries.some(({ dir, ignoreInstance }) => {
		const relativePath = path.relative(dir, filePath);
		if (
			!relativePath ||
			relativePath.startsWith("..") ||
			path.isAbsolute(relativePath)
		) {
			return false;
		}

		return ignoreInstance.ignores(toPosixPath(relativePath));
	});
}
