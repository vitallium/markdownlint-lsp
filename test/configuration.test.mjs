import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Configuration Loading", function () {
	this.timeout(10000);

	let client;
	let tempDir;
	let fixturesDir;
	async function prepareTestDir(name) {
		const dir = path.join(tempDir, name);
		await fs.rm(dir, { recursive: true, force: true });
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	before(async () => {
		fixturesDir = path.join(__dirname, "fixtures");
		tempDir = path.join(fixturesDir, "temp-config-test");

		// Ensure workspace directories are clean before starting the server
		await fs.rm(tempDir, { recursive: true, force: true });
		await fs.mkdir(tempDir, { recursive: true });

		client = new TestLanguageClient();
		await client.start();
	});

	after(async () => {
		await client.stop();
		// Cleanup temp directory and workspace-level artifacts
		await fs.rm(tempDir, { recursive: true, force: true });
		await fs.rm(path.join(fixturesDir, "package.json"), {
			force: true,
		});
	});

	describe("Configuration File Formats", () => {
		it("should load .markdownlint.json configuration", async () => {
			const configContent = JSON.stringify({
				default: true,
				MD013: false,
				MD009: { br_spaces: 2 },
			});

			const testDir = await prepareTestDir("json");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.json"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test.md")}`;
			const content =
				"This is a very long line that exceeds the default line length limit but should not trigger MD013\n\nLine with two spaces  \n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// MD013 should be disabled
			const md013 = publishedDiagnostics.find((d) => d.code === "MD013");
			expect(md013).to.be.undefined;

			// MD009 should allow 2 spaces before line break
			const md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.be.undefined;
		});

		it("should load .markdownlint.jsonc configuration", async () => {
			const configContent = JSON.stringify({
				default: true,
				MD041: false,
				MD013: { line_length: 120 },
			});

			const testDir = await prepareTestDir("jsonc");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.jsonc"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-jsonc.md")}`;
			const content = "Not a heading on first line\n\n# Heading\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// MD041 should be disabled
			const md041 = publishedDiagnostics.find((d) => d.code === "MD041");
			expect(md041).to.be.undefined;
		});

		it("should load .markdownlint.yaml configuration", async () => {
			const configContent = `# YAML configuration
default: true
MD033:
  allowed_elements:
    - br
    - hr
    - div
MD013: false
`;

			const testDir = await prepareTestDir("yaml");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.yaml"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-yaml.md")}`;
			const content =
				"Text with <br> and <div>content</div> and <script>bad</script>\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should only have error for script tag
			const md033Diagnostics = publishedDiagnostics.filter(
				(d) => d.code === "MD033",
			);
			expect(md033Diagnostics).to.have.lengthOf(1);
		});

		it("should load .markdownlint.yml configuration", async () => {
			const configContent = `default: true
line-length: false
no-duplicate-heading:
  siblings_only: true
`;

			const testDir = await prepareTestDir("yml");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.yml"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-yml.md")}`;
			const content = `# Heading
## Subheading
### Heading
## Subheading
`;

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should only flag sibling duplicates
			const md024 = publishedDiagnostics.filter((d) => d.code === "MD024");
			expect(md024).to.have.lengthOf(1); // Only the sibling "Subheading" should be flagged
		});

		it("should load .markdownlint.cjs configuration", async () => {
			const testDir = await prepareTestDir("cjs");
			await fs.writeFile(
				path.join(testDir, ".markdownlint.cjs"),
				"module.exports = { default: true, MD013: false };",
			);

			const uri = `file://${path.join(testDir, "test-cjs.md")}`;
			const content =
				"This is a very long line that would normally trigger line length violations\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md013 = publishedDiagnostics.find((d) => d.code === "MD013");
			expect(md013).to.be.undefined;
		});

		it("should load .markdownlint.mjs configuration", async () => {
			const testDir = await prepareTestDir("mjs");
			await fs.writeFile(
				path.join(testDir, ".markdownlint.mjs"),
				"export default { default: true, MD041: false };",
			);

			const uri = `file://${path.join(testDir, "test-mjs.md")}`;
			const content = "Not a heading\n\n# Heading\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md041 = publishedDiagnostics.find((d) => d.code === "MD041");
			expect(md041).to.be.undefined;
		});
	});

	describe("CLI2-style Configuration", () => {
		it("should load .markdownlint-cli2.jsonc configuration", async () => {
			const configContent = `{
				"config": {
					"default": true,
					"MD013": false
				},
				"ignores": ["node_modules/**"]
			}`;

			const testDir = await prepareTestDir("cli2-jsonc");

			await fs.writeFile(
				path.join(testDir, ".markdownlint-cli2.jsonc"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-cli2.md")}`;
			const content =
				"This is a very long line that would normally trigger the line length rule\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md013 = publishedDiagnostics.find((d) => d.code === "MD013");
			expect(md013).to.be.undefined;
		});

		it("should load .markdownlint-cli2.yaml configuration", async () => {
			const configContent = `config:
  default: true
  MD033: false
  MD009:
    br_spaces: 2
`;

			const testDir = await prepareTestDir("cli2-yaml");

			await fs.writeFile(
				path.join(testDir, ".markdownlint-cli2.yaml"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-cli2-yaml.md")}`;
			const content = "Line with <strong>HTML</strong> and trailing spaces  \n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Both MD033 and MD009 should be handled according to config
			const md033 = publishedDiagnostics.find((d) => d.code === "MD033");
			const md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md033).to.be.undefined;
			expect(md009).to.be.undefined;
		});

		it("should load .markdownlint-cli2.cjs configuration", async () => {
			const testDir = await prepareTestDir("cli2-cjs");
			await fs.writeFile(
				path.join(testDir, ".markdownlint-cli2.cjs"),
				"module.exports = { config: { default: true, MD013: false } };",
			);

			const uri = `file://${path.join(testDir, "test-cli2-cjs.md")}`;
			const content =
				"This is a very long line that would normally trigger line length violations\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md013 = publishedDiagnostics.find((d) => d.code === "MD013");
			expect(md013).to.be.undefined;
		});

		it("should load .markdownlint-cli2.mjs configuration", async () => {
			const testDir = await prepareTestDir("cli2-mjs");
			await fs.writeFile(
				path.join(testDir, ".markdownlint-cli2.mjs"),
				"export default { config: { default: true, MD041: false } };",
			);

			const uri = `file://${path.join(testDir, "test-cli2-mjs.md")}`;
			const content = "Not a heading\n\n# Heading\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md041 = publishedDiagnostics.find((d) => d.code === "MD041");
			expect(md041).to.be.undefined;
		});
	});

	describe("Configuration Hierarchy", () => {
		it("should use closest configuration file", async () => {
			// Create nested directory structure
			const baseDir = await prepareTestDir("hierarchy");
			const nestedDir = path.join(baseDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });

			// Root config - strict
			await fs.writeFile(
				path.join(baseDir, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD013: { line_length: 80 },
				}),
			);

			// Nested config - relaxed
			await fs.writeFile(
				path.join(nestedDir, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD013: false,
				}),
			);

			// Test file in nested directory
			const uri = `file://${path.join(nestedDir, "test.md")}`;
			const content =
				"This is a very long line that exceeds 80 characters but should not trigger an error\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should use nested config (MD013 disabled)
			const md013 = publishedDiagnostics.find((d) => d.code === "MD013");
			expect(md013).to.be.undefined;
		});

		it("should respect configuration precedence", async () => {
			// Create both .markdownlint-cli2.jsonc and .markdownlint.json
			const testDir = await prepareTestDir("precedence");
			await fs.writeFile(
				path.join(testDir, ".markdownlint-cli2.jsonc"),
				JSON.stringify({
					config: {
						default: true,
						MD041: false, // Disable in CLI2 config
					},
				}),
			);

			await fs.writeFile(
				path.join(testDir, ".markdownlint.json"),
				JSON.stringify({
					default: true,
					MD041: true, // Enable in standard config
				}),
			);

			const uri = `file://${path.join(testDir, "test-precedence.md")}`;
			const content = "Not a heading\n\n# Actual heading\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// CLI2 config should take precedence
			const md041 = publishedDiagnostics.find((d) => d.code === "MD041");
			expect(md041).to.be.undefined;
		});
	});

	describe("RC-style Configuration", () => {
		it("should load .markdownlintrc configuration", async () => {
			const testDir = await prepareTestDir("rc");
			const configContent = JSON.stringify({
				default: true,
				MD010: false,
				MD013: false,
			});

			await fs.writeFile(path.join(testDir, ".markdownlintrc"), configContent);

			const uri = `file://${path.join(testDir, "test-rc.md")}`;
			const content = "\tThis line has a tab but should not error\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			const md010 = publishedDiagnostics.find((d) => d.code === "MD010");
			expect(md010).to.be.undefined;
		});
	});

	describe("Package.json Configuration", () => {
		it("should load configuration from package.json", async () => {
			const packageContent = JSON.stringify(
				{
					name: "test-project",
					version: "1.0.0",
					"markdownlint-cli2": {
						config: {
							default: true,
							MD033: {
								allowed_elements: ["img", "br"],
							},
						},
					},
				},
				null,
				2,
			);

			const packagePath = path.join(fixturesDir, "package.json");
			await fs.writeFile(packagePath, packageContent);

			const testDir = await prepareTestDir("package");

			const uri = `file://${path.join(testDir, "readme.md")}`;
			const content =
				'Text with <img src="test.png"> and <script>bad</script>\n';

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should only error on script tag
			const md033 = publishedDiagnostics.filter((d) => d.code === "MD033");
			expect(md033).to.have.lengthOf(1);
		});
	});

	describe("Dynamic Configuration", () => {
		it("should reload configuration when config file changes", async () => {
			const testDir = await prepareTestDir("dynamic");
			const configPath = path.join(testDir, ".markdownlint.json");
			const uri = `file://${path.join(testDir, "dynamic-test.md")}`;
			const content = "This line has trailing spaces    \n";

			// Initial config - allow trailing spaces
			await fs.writeFile(
				configPath,
				JSON.stringify({
					default: true,
					MD009: false,
				}),
			);

			await client.openTextDocument(uri, content);
			let publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should have no MD009 errors initially
			let md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.be.undefined;

			// Update config - disallow trailing spaces
			await fs.writeFile(
				configPath,
				JSON.stringify({
					default: true,
					MD009: true,
				}),
			);

			const configUri = pathToFileURL(configPath).href;
			const diagnosticsPromise = client.waitForDiagnostics(uri);

			await client.sendRawNotification("workspace/didChangeWatchedFiles", {
				changes: [
					{
						uri: configUri,
						type: 2, // Changed
					},
				],
			});

			publishedDiagnostics = await diagnosticsPromise.then(
				(result) => result.diagnostics,
			);

			// Should now have MD009 error
			md009 = publishedDiagnostics.find((d) => d.code === "MD009");
			expect(md009).to.exist;
		});
	});

	describe("Invalid Configuration Handling", () => {
		it("should handle malformed JSON gracefully", async () => {
			const configContent = '{ "default": true, "MD013": false,, }'; // Invalid JSON

			const testDir = await prepareTestDir("invalid-json");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.json"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-invalid.md")}`;
			const content = "#No space\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should fall back to default configuration
			const md018 = publishedDiagnostics.find((d) => d.code === "MD018");
			expect(md018).to.exist;
		});

		it("should handle invalid YAML gracefully", async () => {
			const configContent = `default: true
MD013: false
  invalid: indentation: here
`;

			const testDir = await prepareTestDir("invalid-yaml");

			await fs.writeFile(
				path.join(testDir, ".markdownlint.yaml"),
				configContent,
			);

			const uri = `file://${path.join(testDir, "test-invalid-yaml.md")}`;
			const content = "	Hard tab\n";

			await client.openTextDocument(uri, content);
			const publishedDiagnostics = await client.waitForDiagnosticsArray(uri);

			// Should fall back to default configuration
			const md010 = publishedDiagnostics.find((d) => d.code === "MD010");
			expect(md010).to.exist;
		});
	});
});
