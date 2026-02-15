import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { getConfigCacheKey } from "../lib/cache-keys.mjs";

describe("Config Cache Key", () => {
	it("should key file URIs by directory", () => {
		const workspaceRoot = path.join("/", "workspace");
		const filePath = path.join(workspaceRoot, "docs", "readme.md");
		const uri = pathToFileURL(filePath).href;

		const key = getConfigCacheKey(uri, workspaceRoot);
		expect(key).to.equal(
			`${workspaceRoot}:${path.join(workspaceRoot, "docs")}`,
		);
	});

	it("should key non-file URIs by full URI", () => {
		const workspaceRoot = "/workspace";
		const uri = "untitled:notes";

		const key = getConfigCacheKey(uri, workspaceRoot);
		expect(key).to.equal(`${workspaceRoot}:${uri}`);
	});
});
