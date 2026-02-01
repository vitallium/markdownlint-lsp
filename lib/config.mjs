import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { readConfig as readMarkdownlintConfig } from "markdownlint/promise";
import mergeOptions from "./merge-options.mjs";

// The order of these filenames is important and reflects the precedence
// that markdownlint-cli2 uses for configuration files.
// See: https://github.com/DavidAnson/markdownlint-cli2#configuration
export const MARKDOWNLINT_CLI2_CONFIG_FILENAMES = [
	".markdownlint-cli2.jsonc",
	".markdownlint-cli2.yaml",
	".markdownlint-cli2.yml",
	".markdownlint-cli2.cjs",
	".markdownlint-cli2.mjs",
];

const MARKDOWNLINT_CONFIG_FILENAMES = [
	".markdownlint.jsonc",
	".markdownlint.json",
	".markdownlint.yaml",
	".markdownlint.yml",
	".markdownlint.cjs",
	".markdownlint.mjs",
];

// RC-style configuration files (following https://www.npmjs.com/package/rc)
const MARKDOWNLINT_RC_CONFIG_FILENAMES = [
	".markdownlintrc",
	".markdownlint/config",
];

export const ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON = [
	...MARKDOWNLINT_CLI2_CONFIG_FILENAMES,
	...MARKDOWNLINT_CONFIG_FILENAMES,
	...MARKDOWNLINT_RC_CONFIG_FILENAMES,
];

const ALL_CONFIG_FILENAMES = [
	...ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON,
	"package.json",
];

const PARSERS = [(content) => yaml.load(content)];
const MAX_LOG_CONFIG_LENGTH = 2000;
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|auth/i;

function redactConfig(value) {
	if (Array.isArray(value)) {
		return value.map((item) => redactConfig(item));
	}
	if (value && typeof value === "object") {
		const redacted = {};
		for (const [key, entry] of Object.entries(value)) {
			if (SENSITIVE_KEY_PATTERN.test(key)) {
				redacted[key] = "<<redacted>>";
				continue;
			}
			redacted[key] = redactConfig(entry);
		}
		return redacted;
	}
	return value;
}

function formatConfigForLog(value) {
	try {
		const sanitized = redactConfig(value);
		const serialized = JSON.stringify(sanitized, null, 2);
		if (serialized.length <= MAX_LOG_CONFIG_LENGTH) {
			return serialized;
		}
		return `${serialized.slice(0, MAX_LOG_CONFIG_LENGTH)}... (truncated)`;
	} catch (error) {
		return `<<unserializable config: ${error}>>`;
	}
}

function isSubdirectory(parent, child) {
	if (child === parent) return true;
	const relative = path.relative(parent, child);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function findHighestPrecedenceConfigFileInDir(dir, filenames, logger) {
	for (const filename of filenames) {
		const configPath = path.join(dir, filename);
		try {
			const config = await readMarkdownlintConfig(configPath, PARSERS);

			if (filename === "package.json") {
				if (config["markdownlint-cli2"]) {
					logger(`Found config in ${configPath}`, true);
					return {
						filepath: configPath,
						config: config["markdownlint-cli2"],
					};
				}
				// If no `markdownlint-cli2` key, it's not a config file for us.
				continue;
			}

			if (config) {
				logger(`Found config file: ${configPath}`, true);
				return { filepath: configPath, config };
			}
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "EISDIR") {
				logger(`Error reading or parsing ${configPath}: ${error}`, true);
			}
		}
	}
	return null;
}

/**
 * Loads configuration for a given file, traversing up the directory tree
 * from the file's location to the workspace root, and merging all found
 * configurations.
 *
 * @param {string} fileUri The URI of the markdown file.
 * @param {string} workspaceRoot The absolute path to the workspace root.
 * @param {Function} [logger=()=>{}] Optional logger function.
 * @returns {Promise<object|null>} A promise that resolves to the final
 * markdownlint options object, or null if no configuration is found.
 */
export async function loadConfig(fileUri, workspaceRoot, logger = () => {}) {
	if (!fileUri.startsWith("file:")) {
		logger("Skipping config load for non-file URI", true);
		return null;
	}

	const filePath = fileURLToPath(fileUri);
	const startDir = path.dirname(filePath);

	const directoriesToSearch = [];
	let currentDir = startDir;

	while (isSubdirectory(workspaceRoot, currentDir)) {
		directoriesToSearch.push(currentDir);
		if (currentDir === workspaceRoot) {
			break;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			break;
		}
		currentDir = parentDir;
	}

	const configPromises = directoriesToSearch.map((dir) => {
		const filenames =
			dir === workspaceRoot
				? ALL_CONFIG_FILENAMES
				: ALL_CONFIG_FILENAMES_EXCEPT_PACKAGE_JSON;
		return findHighestPrecedenceConfigFileInDir(dir, filenames, logger);
	});

	const foundConfigs = (await Promise.all(configPromises)).filter(Boolean);

	if (foundConfigs.length === 0) {
		logger("No config files found in the file's path.", true);
		return null;
	}

	let mergedOptions = {};
	for (const { config, filepath } of foundConfigs.reverse()) {
		const filename = path.basename(filepath);
		logger(`Applying config from ${filepath}`, true);

		// Check if this is a markdownlint-specific config file (not CLI2)
		const isMarkdownlintConfig =
			MARKDOWNLINT_CONFIG_FILENAMES.includes(filename) ||
			filepath.endsWith(".markdownlintrc") ||
			filepath.endsWith(".markdownlint/config");

		if (isMarkdownlintConfig) {
			mergedOptions.config = config;
		} else {
			mergedOptions = mergeOptions(mergedOptions, config);
		}
	}

	if (Object.keys(mergedOptions).length > 0) {
		if (logger) {
			logger(`Final merged config: ${formatConfigForLog(mergedOptions)}`, true);
		}
		return mergedOptions;
	}

	return null;
}
