import path from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "markdownlint/promise";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver/node.js";
import { IgnorePatternSet } from "./ignore-pattern-set.mjs";
import mergeOptions from "./merge-options.mjs";

export class DocumentValidator {
	#codec;
	#logger;

	constructor({ codec, logger = () => {} }) {
		this.#codec = codec;
		this.#logger = logger;
	}

	async validate({ document, documentOptions, settings, workspaceRoot }) {
		const mergedOptions = mergeOptions(documentOptions, settings);

		if (this.#isIgnored(document.uri, mergedOptions, workspaceRoot)) {
			this.#logger(`Ignoring ${document.uri} (matched ignores pattern)`);
			return {
				ignored: true,
				diagnostics: [],
				issues: [],
				diagnosticFixPairs: [],
			};
		}

		const options = this.#buildLintOptions(document, mergedOptions);
		const results = await lint(options);
		const issues = results[document.uri] || [];
		const { diagnostics, diagnosticFixPairs } = this.#buildDiagnostics(issues);

		return {
			ignored: false,
			issues,
			diagnosticFixPairs,
			diagnostics: this.#codec.convertDiagnosticsFromUtf16(
				diagnostics,
				document,
			),
		};
	}

	#isIgnored(documentUri, mergedOptions, workspaceRoot) {
		if (!documentUri.startsWith("file:")) {
			return false;
		}

		const filePath = fileURLToPath(documentUri);

		const patternSet = new IgnorePatternSet({
			cli2IgnoreEntries: mergedOptions._ignoreEntries || [],
			standardIgnores: mergedOptions.ignores || [],
			markdownlintIgnoreEntries: mergedOptions._markdownlintIgnoreEntries || [],
			workspaceRoot,
		});

		return patternSet.matches(filePath, workspaceRoot);
	}



	#buildLintOptions(document, mergedOptions) {
		const {
			_ignoreEntries: _ignored,
			_markdownlintIgnoreEntries: _markdownlintIgnored,
			ignores: _settingsIgnores,
			...lintOptions
		} = mergedOptions;

		return {
			...lintOptions,
			strings: {
				[document.uri]: document.getText(),
			},
			handleRuleFailures: true,
		};
	}

	#buildDiagnostics(issues) {
		const diagnostics = [];
		const diagnosticFixPairs = [];

		for (const issue of issues) {
			const line = (issue.lineNumber || 1) - 1;
			const [startChar, length] = issue.errorRange
				? [(issue.errorRange[0] || 1) - 1, issue.errorRange[1]]
				: [0, 1];

			const diagnostic = Diagnostic.create(
				{
					start: { line, character: startChar },
					end: { line, character: startChar + length },
				},
				`${issue.ruleDescription} (${issue.ruleNames.join("/")})`,
				DiagnosticSeverity.Warning,
				issue.ruleNames[0],
				"markdownlint",
			);

			diagnostics.push(diagnostic);

			if (issue.fixInfo) {
				diagnosticFixPairs.push({
					diagnostic,
					fixInfo: issue.fixInfo,
				});
			}
		}

		return { diagnostics, diagnosticFixPairs };
	}
}
