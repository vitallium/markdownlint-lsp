import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

export const MARKDOWNLINT_IGNORE_FILENAME = ".markdownlintignore";

/**
 * Loads `.markdownlintignore` files into one matcher rooted at the workspace.
 * Parent and child rules share a matcher so child negations can override parents.
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
	const root = directories.at(-1);
	const ignoreInstance = ignore();
	let found = false;

	for (const dir of directories.toReversed()) {
		const ignorePath = path.join(dir, MARKDOWNLINT_IGNORE_FILENAME);
		try {
			const content = await fs.readFile(ignorePath, "utf8");
			const scope = path
				.relative(root, dir)
				.split(path.sep)
				.join("/")
				.replace(/[\\*?[\]]/g, "\\$&");
			const patterns = content
				.replace(/^\uFEFF/, "")
				.split(/\r?\n/)
				.map((line) => {
					if (!scope || !line.trim() || line.startsWith("#")) return line;
					const negative = line.startsWith("!");
					const pattern = negative ? line.slice(1) : line;
					if (!pattern || pattern === "/") return "";
					const anchored = pattern.replace(/\/$/, "").includes("/");
					return `${negative ? "!" : ""}/${scope}/${anchored ? "" : "**/"}${pattern.replace(/^\//, "")}`;
				});
			ignoreInstance.add(patterns);
			logger(`Found ignore file: ${ignorePath}`, true);
			found = true;
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "EISDIR") {
				logger(`Error reading ${ignorePath}: ${error}`, true);
			}
		}
	}

	return found ? [{ dir: root, ignoreInstance }] : [];
}
