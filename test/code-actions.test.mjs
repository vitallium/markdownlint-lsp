import { expect } from "chai";
import { describe, it } from "mocha";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CodeActions } from "../lib/code-actions.mjs";

const codec = {
	convertDiagnosticFromUtf16: (diagnostic) => diagnostic,
	convertDiagnosticToUtf16: (diagnostic) => diagnostic,
	convertRangeToUtf16: (range) => range,
	convertTextEditFromUtf16: (edit) => edit,
};

const diagnostic = {
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 },
	},
	code: "MD001",
	message: "test diagnostic",
};

const document = TextDocument.create("file:///test.md", "markdown", 1, "# H\n");
const range = {
	start: { line: 0, character: 0 },
	end: { line: 0, character: 0 },
};

describe("CodeActions", () => {
	it("uses the first fix pair when diagnostic keys collide", () => {
		const actions = new CodeActions({ codec }).build({
			uri: document.uri,
			document,
			params: {
				range,
				context: { only: ["quickfix"], diagnostics: [diagnostic] },
			},
			diagnosticFixPairs: [
				{
					diagnostic,
					fixInfo: { lineNumber: 1, editColumn: 1, insertText: "first" },
				},
				{
					diagnostic,
					fixInfo: { lineNumber: 1, editColumn: 1, insertText: "last" },
				},
			],
			issues: [],
		});

		expect(actions).to.have.lengthOf(1);
		expect(actions[0].edit.changes[document.uri][0].newText).to.equal("first");
	});

	it("does not read fix pairs for fix-all-only requests", () => {
		const diagnosticFixPairs = [
			{
				get diagnostic() {
					throw new Error("quick-fix diagnostics should not be read");
				},
			},
		];

		expect(() =>
			new CodeActions({ codec }).build({
				uri: document.uri,
				document,
				params: {
					range,
					context: { only: ["source.fixAll"], diagnostics: [] },
				},
				diagnosticFixPairs,
				issues: [],
			}),
		).not.to.throw();
	});

	it("looks up each requested diagnostic without rescanning fix pairs", () => {
		const reads = Array(10).fill(0);
		const diagnostics = reads.map((_, index) => ({
			range: {
				start: { line: 0, character: index },
				end: { line: 0, character: index + 1 },
			},
			code: `MD${index}`,
			message: `diagnostic ${index}`,
		}));
		const diagnosticFixPairs = diagnostics.map((value, index) => ({
			get diagnostic() {
				reads[index] += 1;
				return value;
			},
			fixInfo: { lineNumber: 1, editColumn: index + 1, insertText: "x" },
		}));

		const actions = new CodeActions({ codec }).build({
			uri: document.uri,
			document,
			params: {
				range,
				context: { only: ["quickfix"], diagnostics },
			},
			diagnosticFixPairs,
			issues: [],
		});

		expect(actions).to.have.lengthOf(diagnostics.length);
		expect(reads).to.deep.equal(Array(10).fill(2));
	});
});
