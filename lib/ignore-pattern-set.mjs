import path from "node:path";
import { minimatch } from "minimatch";

/**
 * Unified ignore pattern set that consolidates ignore pattern matching from
 * multiple sources:
 * - CLI2 config `ignores` arrays (with directory context)
 * - Standard markdownlint config `ignores` property
 * - `.markdownlintignore` files (via ignore package instances)
 */
export class IgnorePatternSet {
	/**
	 * @param {object} options
	 * @param {Array<{dir: string, patterns: string[]}>} [options.cli2IgnoreEntries] CLI2-style ignore entries with directory context
	 * @param {string[]} [options.standardIgnores] Standard markdownlint ignores (no directory context)
	 * @param {Array<{dir: string, ignoreInstance: import("ignore").Ignore}>} [options.markdownlintIgnoreEntries] .markdownlintignore file entries
	 * @param {string} [options.workspaceRoot] Workspace root for standard ignores
	 */
	constructor({
		cli2IgnoreEntries = [],
		standardIgnores = [],
		markdownlintIgnoreEntries = [],
		workspaceRoot = process.cwd(),
	} = {}) {
		this.cli2IgnoreEntries = cli2IgnoreEntries;
		this.standardIgnores = standardIgnores;
		this.markdownlintIgnoreEntries = markdownlintIgnoreEntries;
		this.workspaceRoot = workspaceRoot;
	}

	/**
	 * Check if a file path matches any ignore pattern from any source.
	 *
	 * @param {string} filePath Absolute file path to check
	 * @param {string} [workspaceRoot] Workspace root (defaults to constructor's workspaceRoot)
	 * @returns {boolean} True if the file should be ignored
	 */
	matches(filePath, workspaceRoot = this.workspaceRoot) {
		// Check CLI2 ignore entries first
		if (this.cli2IgnoreEntries.length > 0) {
			for (const { dir, patterns } of this.cli2IgnoreEntries) {
				const relPath = path
					.relative(dir, filePath)
					.split(path.sep)
					.join("/");
				
				for (const pattern of patterns) {
					if (IgnorePatternSet.#matchesPattern(relPath, pattern)) {
						return true;
					}
				}
			}
		}

		// Check standard ignores (from markdownlint config or settings)
		if (this.standardIgnores.length > 0) {
			const relPath = path
				.relative(workspaceRoot, filePath)
				.split(path.sep)
				.join("/");
			
			for (const pattern of this.standardIgnores) {
				if (IgnorePatternSet.#matchesPattern(relPath, pattern)) {
					return true;
				}
			}
		}

		// Check .markdownlintignore files
		if (this.markdownlintIgnoreEntries.length > 0) {
			for (const { dir, ignoreInstance } of this.markdownlintIgnoreEntries) {
				const relativePath = path.relative(dir, filePath);
				if (
					!relativePath ||
					relativePath.startsWith("..") ||
					path.isAbsolute(relativePath)
				) {
					continue;
				}

				const toPosixPath = (p) => p.split(path.sep).join("/");
				if (ignoreInstance.ignores(toPosixPath(relativePath))) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Match a relative path against a pattern, with special handling for
	 * directory-style patterns.
	 *
	 * markdownlint-cli2's `ignores` option uses globby-style glob matching,
	 * where a bare directory name (e.g. "dist") does not recursively match
	 * files inside that directory. This supplements minimatch with
	 * directory-prefix checks so directory-style patterns behave like
	 * gitignore users commonly expect, at the cost of diverging slightly from
	 * markdownlint-cli2's own CLI behavior for such patterns.
	 *
	 * @param {string} relPath Relative path (POSIX-style)
	 * @param {string} pattern Pattern to match against
	 * @returns {boolean} True if the path matches the pattern
	 */
	static #matchesPattern(relPath, pattern) {
		const cleanPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
		return (
			minimatch(relPath, pattern, {
				dot: true,
				matchBase: !pattern.includes("/"),
			}) ||
			relPath === cleanPattern ||
			relPath.startsWith(`${cleanPattern}/`)
		);
	}
}
