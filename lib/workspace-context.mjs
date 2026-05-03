import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigCacheKey } from "./cache-keys.mjs";
import { loadConfig } from "./config.mjs";

export class WorkspaceContext {
	#configCache = new Map();
	#configCacheMaxSize;
	#configChangeDebounceMs;
	#configChangeTimeout = null;
	#rootPath = null;
	#workspaceFolders = [];

	constructor({ configCacheMaxSize, configChangeDebounceMs }) {
		this.#configCacheMaxSize = configCacheMaxSize;
		this.#configChangeDebounceMs = configChangeDebounceMs;
	}

	initialize({ rootPath, rootUri, workspaceFolders = [] }) {
		this.#workspaceFolders = workspaceFolders;
		this.#rootPath = this.#chooseRootPath(rootPath, rootUri, workspaceFolders);
	}

	scheduleConfigReload(onReload, logger = () => {}) {
		if (this.#configChangeTimeout) {
			clearTimeout(this.#configChangeTimeout);
		}

		this.#configChangeTimeout = setTimeout(() => {
			logger(
				"Configuration file changed. Clearing config cache and re-validating all documents.",
			);
			this.clearCache();
			onReload();
			this.#configChangeTimeout = null;
		}, this.#configChangeDebounceMs);
	}

	clearCache() {
		this.#configCache.clear();
	}

	updateWorkspaceFolders(event, logger = () => {}) {
		this.#workspaceFolders = this.#workspaceFolders.filter(
			(folder) =>
				!event.removed.some(
					(removedFolder) => removedFolder.uri === folder.uri,
				),
		);

		this.#workspaceFolders.push(...event.added);

		const rootPathStillPresent = this.#isPathInWorkspaceFolders(this.#rootPath);
		if (!rootPathStillPresent) {
			this.#rootPath = this.#chooseRootPath(null, null, this.#workspaceFolders);
		}

		logger(
			`Updated workspace folders: ${this.#workspaceFolders.map((folder) => folder.uri).join(", ")}`,
		);
		logger("Clearing config cache due to workspace folder changes.");
		this.clearCache();
	}

	getWorkspaceRootFor(documentUri, logger = () => {}) {
		if (!documentUri.startsWith("file:")) {
			return this.#rootPath ?? process.cwd();
		}

		let docPath;
		try {
			docPath = fileURLToPath(documentUri);
		} catch (error) {
			logger(`Invalid file URI: ${documentUri}: ${error}`);
			return this.#rootPath ?? process.cwd();
		}

		let matchingFolderPath = null;

		for (const folder of this.#workspaceFolders) {
			if (folder.uri?.startsWith("file:")) {
				try {
					const folderPath = fileURLToPath(folder.uri);
					const relative = path.relative(folderPath, docPath);
					if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
						if (
							!matchingFolderPath ||
							folderPath.length > matchingFolderPath.length
						) {
							matchingFolderPath = folderPath;
						}
					}
				} catch (error) {
					logger(`Invalid workspace folder URI: ${folder.uri}: ${error}`);
				}
			}
		}

		return matchingFolderPath ?? this.#rootPath ?? process.cwd();
	}

	async loadDocumentOptions(
		documentUri,
		allowJavaScriptConfig,
		logger = () => {},
	) {
		const workspaceRoot = this.getWorkspaceRootFor(documentUri, logger);
		const cacheKey = getConfigCacheKey(documentUri, workspaceRoot);
		let documentOptions = this.#configCache.get(cacheKey);

		if (!documentOptions) {
			documentOptions =
				(await loadConfig(documentUri, workspaceRoot, logger, {
					allowJavaScriptConfig,
				})) || {};

			if (this.#configCache.size >= this.#configCacheMaxSize) {
				const oldestKey = this.#configCache.keys().next().value;
				this.#configCache.delete(oldestKey);
				logger(`Evicted oldest config cache entry: ${oldestKey}`);
			}

			this.#configCache.set(cacheKey, documentOptions);
			logger(`Cached config for ${cacheKey}`);
		} else {
			this.#configCache.delete(cacheKey);
			this.#configCache.set(cacheKey, documentOptions);
			logger(`Using cached config for ${cacheKey}`);
		}

		return {
			documentOptions,
			workspaceRoot,
		};
	}

	#chooseRootPath(rootPath, rootUri, workspaceFolders = []) {
		if (rootPath) {
			return rootPath;
		}

		if (rootUri?.startsWith("file:")) {
			return fileURLToPath(rootUri);
		}

		const primaryFolder = workspaceFolders.find((folder) =>
			folder.uri?.startsWith("file:"),
		);
		if (primaryFolder?.uri) {
			return fileURLToPath(primaryFolder.uri);
		}

		return null;
	}

	#isPathInWorkspaceFolders(targetPath) {
		if (!targetPath) {
			return false;
		}

		const normalizedTarget = path.normalize(targetPath);

		return this.#workspaceFolders.some((folder) => {
			if (!folder.uri?.startsWith("file:")) {
				return false;
			}
			const folderPath = fileURLToPath(folder.uri);
			return path.normalize(folderPath) === normalizedTarget;
		});
	}
}
