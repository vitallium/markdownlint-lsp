import path from "node:path";
import { fileURLToPath } from "node:url";

export function getConfigCacheKey(documentUri, workspaceRoot) {
	const root = workspaceRoot || process.cwd();
	if (!documentUri || !documentUri.startsWith("file:")) {
		return `${root}:${documentUri}`;
	}

	try {
		const filePath = fileURLToPath(documentUri);
		const directory = path.dirname(filePath);
		return `${root}:${directory}`;
	} catch {
		return `${root}:${documentUri}`;
	}
}
