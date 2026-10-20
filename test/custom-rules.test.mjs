import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

// Line-based rule that doesn't need markdown-it
const NO_TODO_RULE = `module.exports = {
	names: ["no-todo"],
	description: "No TODO markers",
	tags: ["test"],
	parser: "none",
	function: (params, onError) => {
		params.lines.forEach((line, index) => {
			if (line.includes("TODO")) {
				onError({ lineNumber: index + 1 });
			}
		});
	},
};
`;

// Rule without a parser declaration, so markdownlint treats it as markdown-it
const MDIT_HEADING_RULE = `export default {
	names: ["mdit-heading"],
	description: "Reports markdown-it heading tokens",
	tags: ["test"],
	function: (params, onError) => {
		for (const token of params.parsers.markdownit.tokens) {
			if (token.type === "heading_open") {
				onError({ lineNumber: token.lineNumber });
			}
		}
	},
};
`;

// markdown-it plugin that adds a marker token containing its parameter
const MARKER_PLUGIN = `module.exports = (md, label) => {
	md.core.ruler.push("marker", (state) => {
		const token = new state.Token("plugin_marker", "", 0);
		token.content = label;
		token.map = [0, 1];
		state.tokens.push(token);
	});
};
`;

const MARKER_RULE = `module.exports = {
	names: ["plugin-marker"],
	description: "Reports plugin marker tokens",
	tags: ["test"],
	parser: "markdownit",
	function: (params, onError) => {
		for (const token of params.parsers.markdownit.tokens) {
			if (token.type === "plugin_marker" && token.content === "hello") {
				onError({ lineNumber: 1 });
			}
		}
	},
};
`;

const PACKAGE_RULES = `module.exports = [
	{
		names: ["pkg-one"],
		description: "Package rule one",
		tags: ["test"],
		parser: "none",
		function: (params, onError) => onError({ lineNumber: 1 }),
	},
	{
		names: ["pkg-two"],
		description: "Package rule two",
		tags: ["test"],
		parser: "none",
		function: (params, onError) => onError({ lineNumber: 1 }),
	},
];
`;

const DOCUMENT = "# One\n\n# Two\n\nTODO: fix this\n";

describe("Custom rules", function () {
	this.timeout(10000);

	let tempDir;
	let trustedClient;
	let untrustedClient;
	let documentCount = 0;

	async function write(relativePath, content) {
		const filePath = path.join(tempDir, relativePath);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
	}

	async function lintIn(client, directory, content = DOCUMENT) {
		documentCount += 1;
		const uri = pathToFileURL(
			path.join(tempDir, directory, `doc-${documentCount}.md`),
		).href;
		const beforeMessages = client.logMessages.length;
		await client.openTextDocument(uri, content);
		const diagnostics = await client.waitForDiagnosticsArray(uri);
		return {
			codes: diagnostics.map((diagnostic) => diagnostic.code),
			logs: client.logMessages.slice(beforeMessages),
		};
	}

	before(async () => {
		tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-custom-rules-"),
		);
		await write("rules/no-todo.cjs", NO_TODO_RULE);
		await write("rules/mdit-heading.mjs", MDIT_HEADING_RULE);
		await write("rules/marker-plugin.cjs", MARKER_PLUGIN);
		await write("rules/marker-rule.cjs", MARKER_RULE);
		await write("rules/invalid.cjs", "module.exports = {};\n");
		await write(
			"node_modules/markdownlint-rule-pkg/package.json",
			JSON.stringify({ name: "markdownlint-rule-pkg", main: "index.cjs" }),
		);
		await write("node_modules/markdownlint-rule-pkg/index.cjs", PACKAGE_RULES);

		const rootUri = pathToFileURL(tempDir).href;
		trustedClient = new TestLanguageClient({
			rootUri,
			initializationOptions: { allowJavaScriptConfig: true },
		});
		untrustedClient = new TestLanguageClient({ rootUri });
		await trustedClient.start();
		await untrustedClient.start();
	});

	after(async () => {
		await trustedClient.stop();
		await untrustedClient.stop();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("loads custom rules relative to a YAML config", async () => {
		await write(
			"yaml/.markdownlint-cli2.yaml",
			"customRules:\n  - ../rules/no-todo.cjs\n  - ../rules/mdit-heading.mjs\n",
		);

		const { codes } = await lintIn(trustedClient, "yaml");

		expect(codes).to.include("MD025");
		expect(codes).to.include("no-todo");
		expect(codes.filter((code) => code === "mdit-heading")).to.have.lengthOf(2);
	});

	it("loads custom rules from packages and flattens arrays", async () => {
		await write(
			"package/.markdownlint-cli2.jsonc",
			JSON.stringify({ customRules: ["markdownlint-rule-pkg"] }),
		);

		const { codes } = await lintIn(trustedClient, "package");

		expect(codes).to.include.members(["pkg-one", "pkg-two", "MD025"]);
	});

	it("applies markdown-it plugins with parameters", async () => {
		await write(
			"plugins/.markdownlint-cli2.yaml",
			[
				"customRules:",
				"  - ../rules/marker-rule.cjs",
				"markdownItPlugins:",
				"  - - ../rules/marker-plugin.cjs",
				"    - hello",
				"",
			].join("\n"),
		);

		const { codes } = await lintIn(trustedClient, "plugins");

		expect(codes).to.include("plugin-marker");
	});

	it("supports markdown-it rule objects from a JavaScript config", async () => {
		await write(
			"js-config/.markdownlint-cli2.mjs",
			[
				'import rule from "../rules/mdit-heading.mjs";',
				"export default { customRules: [rule] };",
				"",
			].join("\n"),
		);

		const { codes } = await lintIn(trustedClient, "js-config");

		expect(codes).to.include("mdit-heading");
	});

	it("lets a nested config replace its parent's custom rules", async () => {
		await write(
			"nested/.markdownlint-cli2.yaml",
			"customRules:\n  - ../rules/no-todo.cjs\n",
		);
		await write(
			"nested/child/.markdownlint-cli2.yaml",
			"customRules:\n  - ../../rules/mdit-heading.mjs\n",
		);

		const parent = await lintIn(trustedClient, "nested");
		const child = await lintIn(trustedClient, "nested/child");

		expect(parent.codes).to.include("no-todo");
		expect(parent.codes).to.not.include("mdit-heading");
		expect(child.codes).to.include("mdit-heading");
		expect(child.codes).to.not.include("no-todo");
	});

	it("resolves custom rules from settings relative to the workspace root", async () => {
		const client = new TestLanguageClient({
			rootUri: pathToFileURL(tempDir).href,
			initializationOptions: {
				allowJavaScriptConfig: true,
				customRules: ["./rules/no-todo.cjs"],
			},
		});
		await client.start();
		try {
			const { codes } = await lintIn(client, "settings");
			expect(codes).to.include("no-todo");
		} finally {
			await client.stop();
		}
	});

	it("skips custom rule modules unless JavaScript config is allowed", async () => {
		await write(
			"untrusted/.markdownlint-cli2.yaml",
			"customRules:\n  - ../rules/no-todo.cjs\n",
		);

		const { codes, logs } = await lintIn(untrustedClient, "untrusted");

		expect(codes).to.include("MD025");
		expect(codes).to.not.include("no-todo");
		expect(
			logs.some(
				(log) =>
					log.type === 2 &&
					log.message.includes("requires allowJavaScriptConfig"),
			),
		).to.equal(true);
	});

	it("warns about missing modules and keeps the rest", async () => {
		await write(
			"missing/.markdownlint-cli2.yaml",
			"customRules:\n  - ../rules/does-not-exist.cjs\n  - ../rules/no-todo.cjs\n",
		);

		const { codes, logs } = await lintIn(trustedClient, "missing");

		expect(codes).to.include.members(["MD025", "no-todo"]);
		expect(
			logs.some(
				(log) => log.type === 2 && log.message.includes("does-not-exist.cjs"),
			),
		).to.equal(true);
	});

	it("falls back to built-in rules when a custom rule is invalid", async () => {
		await write(
			"invalid/.markdownlint-cli2.yaml",
			"customRules:\n  - ../rules/invalid.cjs\n",
		);

		const { codes, logs } = await lintIn(trustedClient, "invalid");

		expect(codes).to.include("MD025");
		expect(
			logs.some(
				(log) => log.type === 1 && log.message.includes("Custom rules failed"),
			),
		).to.equal(true);
	});
});
