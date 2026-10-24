import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";
import { loadConfig } from "../lib/config.mjs";

async function loadConfigCapturingLogs(dir, options = {}) {
	const logs = [];
	const config = await loadConfig(
		pathToFileURL(path.join(dir, "test.md")).href,
		dir,
		(message, level) => logs.push({ message, level }),
		options,
	);
	return { config, logs };
}

function warnings(logs, fragment = "") {
	return logs.filter(
		(log) => log.level === "warning" && log.message.includes(fragment),
	);
}

describe("Config content validation", () => {
	for (const rcFilename of [".markdownlintrc", ".markdownlint/config"]) {
		it(`warns and applies no config for INI-format ${rcFilename}`, async () => {
			const tempDir = await fs.mkdtemp(
				path.join(os.tmpdir(), "markdownlint-lsp-rc-ini-"),
			);
			try {
				const configPath = path.join(tempDir, rcFilename);
				await fs.mkdir(path.dirname(configPath), { recursive: true });
				await fs.writeFile(configPath, "MD013=false\n");
				await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

				const { config, logs } = await loadConfigCapturingLogs(tempDir);

				expect(config).to.be.null;
				const rcWarnings = warnings(logs, rcFilename);
				expect(rcWarnings).to.have.lengthOf(1);
				expect(rcWarnings[0].message).to.include("failed to load or parse");
				expect(rcWarnings[0].message).to.include(
					"configuration must be a JSON or YAML object",
				);
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});
	}

	it("warns the same way for scalar-content .markdownlint.yaml", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-yaml-scalar-"),
		);
		try {
			await fs.writeFile(
				path.join(tempDir, ".markdownlint.yaml"),
				"MD013=false\n",
			);
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir);

			expect(config).to.be.null;
			const yamlWarnings = warnings(logs, ".markdownlint.yaml");
			expect(yamlWarnings).to.have.lengthOf(1);
			expect(yamlWarnings[0].message).to.include(
				"configuration must be a JSON or YAML object",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("warns the same way for scalar-content .markdownlint.jsonc", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-jsonc-scalar-"),
		);
		try {
			await fs.writeFile(path.join(tempDir, ".markdownlint.jsonc"), "42\n");
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir);

			expect(config).to.be.null;
			const jsoncWarnings = warnings(logs, ".markdownlint.jsonc");
			expect(jsoncWarnings).to.have.lengthOf(1);
			expect(jsoncWarnings[0].message).to.include(
				"configuration must be a JSON or YAML object",
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("loads a valid .markdownlintrc without warnings", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-rc-valid-"),
		);
		try {
			await fs.writeFile(
				path.join(tempDir, ".markdownlintrc"),
				JSON.stringify({ default: true, MD013: false }),
			);
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir);

			expect(config).to.deep.equal({
				config: { default: true, MD013: false },
			});
			expect(warnings(logs)).to.be.empty;
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("loads a valid .markdownlint.yaml without warnings", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-yaml-valid-"),
		);
		try {
			await fs.writeFile(
				path.join(tempDir, ".markdownlint.yaml"),
				"default: true\nMD013: false\n",
			);
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir);

			expect(config).to.deep.equal({
				config: { default: true, MD013: false },
			});
			expect(warnings(logs)).to.be.empty;
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("JavaScript config probing", () => {
	it("logs no warnings when no JavaScript config files exist", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-js-missing-"),
		);
		try {
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir, {
				allowJavaScriptConfig: true,
			});

			expect(config).to.be.null;
			expect(warnings(logs)).to.be.empty;
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("still warns when an existing JavaScript config has a syntax error", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-js-syntax-"),
		);
		try {
			await fs.writeFile(
				path.join(tempDir, ".markdownlint.cjs"),
				"module.exports = {",
			);
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir, {
				allowJavaScriptConfig: true,
			});

			expect(config).to.be.null;
			const cjsWarnings = warnings(logs, ".markdownlint.cjs");
			expect(cjsWarnings).to.have.lengthOf(1);
			expect(cjsWarnings[0].message).to.include("failed to load or parse");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("still warns when an existing JavaScript config imports a missing module", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-js-import-"),
		);
		try {
			await fs.writeFile(
				path.join(tempDir, ".markdownlint.mjs"),
				'import missing from "./does-not-exist.mjs";\nexport default { MD013: false };\n',
			);
			await fs.writeFile(path.join(tempDir, "test.md"), "# Heading\n");

			const { config, logs } = await loadConfigCapturingLogs(tempDir, {
				allowJavaScriptConfig: true,
			});

			expect(config).to.be.null;
			const mjsWarnings = warnings(logs, ".markdownlint.mjs");
			expect(mjsWarnings).to.have.lengthOf(1);
			expect(mjsWarnings[0].message).to.include("does-not-exist.mjs");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
