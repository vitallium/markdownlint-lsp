import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { createTestDocumentUri, TestLanguageClient } from "./helpers.mjs";

describe("Rule default settings precedence", () => {
	const cases = [
		{
			name: "preserves file defaults with absent pulled settings",
			configurationSettings: null,
		},
		{
			name: "preserves file defaults with empty pulled settings",
			configurationSettings: {},
		},
		{
			name: "preserves file defaults with an empty pulled config",
			configurationSettings: { config: {} },
		},
		{
			name: "preserves file defaults without configuration capability",
			capabilities: { workspace: { configuration: false } },
		},
		{
			name: "preserves initialization defaults with absent pulled settings",
			fileConfig: { default: true, MD018: true },
			initializationOptions: { config: { default: false } },
			configurationSettings: null,
		},
		{
			name: "preserves initialization defaults with empty pulled settings",
			fileConfig: { default: true, MD018: true },
			initializationOptions: { config: { default: false } },
			configurationSettings: {},
		},
		{
			name: "allows explicit initialization defaults to override file defaults",
			initializationOptions: { config: { default: true } },
			configurationSettings: {},
			expectedCodes: ["MD041"],
		},
		{
			name: "allows explicit pulled defaults to override initialization and file defaults",
			initializationOptions: { config: { default: false } },
			configurationSettings: { config: { default: true } },
			expectedCodes: ["MD041"],
		},
		{
			name: "allows explicit pulled false defaults to override initialization and file defaults",
			fileConfig: { default: true, MD018: true },
			initializationOptions: { config: { default: true } },
			configurationSettings: { config: { default: false } },
		},
		{
			name: "allows explicit rule settings to override initialization and file rules",
			initializationOptions: { config: { MD041: false } },
			configurationSettings: { config: { MD041: true } },
			expectedCodes: ["MD041"],
		},
		{
			name: "uses markdownlint defaults when no source specifies defaults",
			fileConfig: {},
			configurationSettings: {},
			expectedCodes: ["MD041"],
		},
	];

	for (const {
		name,
		fileConfig = { default: false, MD018: true },
		expectedCodes = [],
		...options
	} of cases) {
		it(name, async () => {
			const root = await fs.mkdtemp(
				fileURLToPath(
					new URL("./fixtures/temp-rule-defaults-", import.meta.url),
				),
			);
			const client = new TestLanguageClient({
				rootUri: pathToFileURL(root).href,
				...options,
			});
			const uri = pathToFileURL(path.join(root, "defaults.md")).href;

			try {
				await fs.writeFile(
					path.join(root, ".markdownlint.json"),
					JSON.stringify(fileConfig),
				);
				await client.start();
				await client.openTextDocument(uri, "text\n");
				const diagnostics = await client.waitForDiagnosticsArray(uri);
				expect(diagnostics.map((diagnostic) => diagnostic.code)).to.deep.equal(
					expectedCodes,
				);

				await client.changeTextDocument(uri, 2, [{ text: "#No space\n" }]);
				const changedDiagnostics = await client.waitForDiagnosticsArray(uri);
				expect(
					changedDiagnostics.map((diagnostic) => diagnostic.code),
				).to.include("MD018");
			} finally {
				await client.stop();
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});

describe("Initialization Settings", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient({
			initializationOptions: {
				noInlineConfig: true,
			},
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should honor noInlineConfig from initialization options", async () => {
		const uri = createTestDocumentUri("inline-config.md");
		const content = `<!-- markdownlint-disable MD013 -->
This is a very long line that should trigger MD013 even though the inline config attempts to disable it.
`;

		await client.openTextDocument(uri, content);
		const diagnostics = await client.waitForDiagnosticsArray(uri);

		const md013 = diagnostics.find((diagnostic) => diagnostic.code === "MD013");
		expect(md013).to.exist;
	});
});

describe("Client configuration on startup", () => {
	it("uses pulled settings before validating a document opened immediately", async () => {
		const client = new TestLanguageClient({
			configurationSettings: { config: { MD013: false } },
			configurationResponseDelay: 100,
		});
		const uri = createTestDocumentUri("cold-start-settings.md");
		const content = `# Title

${Array(26).fill("word").join(" ")}
`;

		try {
			await client.start();
			await client.openTextDocument(uri, content);
			const diagnostics = await client.waitForDiagnosticsArray(uri);
			expect(diagnostics.map((diagnostic) => diagnostic.code)).not.to.include(
				"MD013",
			);
		} finally {
			await client.stop();
		}
	});
});

describe("Initialization Settings ignores", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient({
			initializationOptions: {
				ignores: ["ignored-by-settings.md"],
			},
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should honor ignores from initialization options", async () => {
		const uri = createTestDocumentUri("ignored-by-settings.md");
		const content = "Not a heading\n\n# Heading\n";

		await client.openTextDocument(uri, content);
		const diagnostics = await client.waitForDiagnosticsArray(uri);

		expect(diagnostics).to.have.length(0);
	});
});
