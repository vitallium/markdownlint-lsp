// Module resolution for `customRules` and `markdownItPlugins`, adapted from
// https://github.com/DavidAnson/markdownlint-cli2/blob/main/markdownlint-cli2.mjs

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveModule } from "markdownlint";
import { expandTildePath } from "markdownlint/helpers";

/**
 * Resolves `modulePaths` entries relative to a config file's directory.
 * @param {string} dir Directory of the config file.
 * @param {string[]} modulePaths Module paths from the config.
 * @returns {string[]} Absolute module paths.
 */
export const resolveModulePaths = (dir, modulePaths) =>
	(Array.isArray(modulePaths) ? modulePaths : []).map((modulePath) =>
		path.resolve(dir, expandTildePath(modulePath, os)),
	);

/**
 * Imports a module by ID (package name or path), searching the given
 * directories. Non-string IDs (already-loaded modules) are returned as is.
 * @param {string[]} dirs Directories to resolve from, most specific first.
 * @param {unknown} id Module ID.
 * @returns {Promise<unknown>} The module's default export.
 */
export const importModule = async (dirs, id) => {
	if (typeof id !== "string") {
		return id;
	}
	const expandedId = expandTildePath(id, os);
	const errors = [];
	try {
		let moduleUrl;
		try {
			moduleUrl = pathToFileURL(resolveModule(expandedId, dirs));
		} catch (error) {
			errors.push(error);
			moduleUrl =
				!path.isAbsolute(expandedId) && URL.canParse(expandedId)
					? new URL(expandedId)
					: pathToFileURL(path.resolve(dirs[0], expandedId));
		}
		const module = await import(moduleUrl.href);
		return module.default;
	} catch (error) {
		errors.push(error);
		throw new AggregateError(errors, `Unable to import module '${id}'.`);
	}
};

/**
 * Resolves string entries in `customRules` and `markdownItPlugins` to
 * modules, the same way markdownlint-cli2 does. Importing modules runs code
 * from the workspace, so string entries are dropped (with a warning) unless
 * `allowJavaScriptConfig` is enabled.
 *
 * @param {object} options markdownlint-cli2 style options object.
 * @param {object} context Resolution context.
 * @param {string} context.dir Directory to resolve relative paths from.
 * @param {string} context.source Description of where the options came from.
 * @param {boolean} context.allowJavaScriptConfig Whether imports are allowed.
 * @param {Function} [context.logger] Logger function.
 * @returns {Promise<object>} Options with modules resolved.
 */
export async function resolveOptionModules(
	options,
	{ dir, source, allowJavaScriptConfig, logger = () => {} },
) {
	if (!options || typeof options !== "object") {
		return options;
	}
	const hasCustomRules = Array.isArray(options.customRules);
	const hasPlugins = Array.isArray(options.markdownItPlugins);
	if (!hasCustomRules && !hasPlugins) {
		return options;
	}

	const dirs = [dir, ...resolveModulePaths(dir, options.modulePaths)];
	const resolved = { ...options };

	const load = async (id, kind) => {
		if (typeof id !== "string") {
			return id;
		}
		if (!allowJavaScriptConfig) {
			logger(
				`Skipping ${kind} '${id}' from ${source}: loading modules requires allowJavaScriptConfig`,
				"warning",
			);
			return null;
		}
		try {
			return await importModule(dirs, id);
		} catch (error) {
			const causes = error.errors?.map((cause) => `${cause}`).join("; ");
			logger(
				`Failed to load ${kind} '${id}' from ${source}: ${error.message}${causes ? ` (${causes})` : ""}`,
				"warning",
			);
			return null;
		}
	};

	if (hasCustomRules) {
		const rules = await Promise.all(
			options.customRules.map((id) => load(id, "custom rule")),
		);
		// Expand nested arrays (for packages that export multiple rules)
		resolved.customRules = rules.flat().filter(Boolean);
	}

	if (hasPlugins) {
		const plugins = await Promise.all(
			options.markdownItPlugins.map(async (entry) => {
				const [id, ...params] = Array.isArray(entry) ? entry : [entry];
				const plugin = await load(id, "markdown-it plugin");
				return plugin ? [plugin, ...params] : null;
			}),
		);
		resolved.markdownItPlugins = plugins.filter(Boolean);
	}

	return resolved;
}
