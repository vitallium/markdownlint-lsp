import { applyFixes } from "markdownlint";
import {
	CodeAction,
	CodeActionKind,
	TextEdit,
} from "vscode-languageserver/node.js";

export class CodeActions {
	#codec;
	#logger;

	constructor({ codec, logger = () => {} }) {
		this.#codec = codec;
		this.#logger = logger;
	}

	build({ uri, document, params, diagnosticFixPairs, issues }) {
		if (!diagnosticFixPairs || diagnosticFixPairs.length === 0) {
			return [];
		}

		const requestRange = this.#codec.convertRangeToUtf16(
			params.range,
			document,
		);
		this.#logger(
			`Code actions requested for ${uri} at range ${JSON.stringify(requestRange)}`,
		);

		const codeActions = [];
		const shouldProvideFixAll =
			!params.context.only ||
			params.context.only.includes(CodeActionKind.SourceFixAll) ||
			params.context.only.some((kind) =>
				CodeActionKind.SourceFixAll.startsWith(`${kind}.`),
			);
		const shouldProvideQuickFix =
			!params.context.only ||
			params.context.only.includes(CodeActionKind.QuickFix) ||
			params.context.only.some((kind) =>
				CodeActionKind.QuickFix.startsWith(`${kind}.`),
			);

		if (shouldProvideQuickFix) {
			const requestedDiagnostics =
				params.context.diagnostics?.length > 0
					? params.context.diagnostics.map((diagnostic) => ({
							converted: this.#codec.convertDiagnosticToUtf16(
								diagnostic,
								document,
							),
							original: diagnostic,
						}))
					: diagnosticFixPairs
							.filter((pair) =>
								this.#rangesOverlap(pair.diagnostic.range, requestRange),
							)
							.map((pair) => ({
								converted: pair.diagnostic,
								original: this.#codec.convertDiagnosticFromUtf16(
									pair.diagnostic,
									document,
								),
							}));

			for (const { converted, original } of requestedDiagnostics) {
				const pair = this.#findDiagnosticFixPair(converted, diagnosticFixPairs);
				if (!pair) {
					continue;
				}

				const textEdit = this.#fixInfoToTextEdit(
					pair.fixInfo,
					pair.diagnostic,
					document,
				);
				if (!textEdit) {
					continue;
				}

				const codeAction = CodeAction.create(
					`Fix: ${original.message}`,
					CodeActionKind.QuickFix,
				);
				codeAction.diagnostics = [original];
				codeAction.edit = {
					changes: {
						[uri]: [this.#codec.convertTextEditFromUtf16(textEdit, document)],
					},
				};
				codeActions.push(codeAction);
			}
		}

		if (shouldProvideFixAll) {
			const fixableIssues = issues.filter((issue) => issue.fixInfo);
			if (fixableIssues.length > 0) {
				const original = document.getText();
				const fixed = applyFixes(original, fixableIssues);
				if (fixed !== original) {
					const fullRange = {
						start: { line: 0, character: 0 },
						end: document.positionAt(original.length),
					};
					const fixAllAction = CodeAction.create(
						`Fix all auto-fixable markdownlint issues (${fixableIssues.length})`,
						CodeActionKind.SourceFixAll,
					);
					fixAllAction.edit = {
						changes: {
							[uri]: [
								this.#codec.convertTextEditFromUtf16(
									TextEdit.replace(fullRange, fixed),
									document,
								),
							],
						},
					};
					codeActions.push(fixAllAction);
				}
			}
		}

		this.#logger(`Returning ${codeActions.length} code actions`);
		return codeActions;
	}

	#findDiagnosticFixPair(requestedDiagnostic, diagnosticFixPairs) {
		for (const pair of diagnosticFixPairs) {
			const storedDiagnostic = pair.diagnostic;
			if (
				storedDiagnostic.range.start.line !==
				requestedDiagnostic.range.start.line
			) {
				continue;
			}
			if (
				storedDiagnostic.range.start.character !==
					requestedDiagnostic.range.start.character ||
				storedDiagnostic.range.end.character !==
					requestedDiagnostic.range.end.character
			) {
				continue;
			}
			if (storedDiagnostic.code !== requestedDiagnostic.code) {
				continue;
			}
			return pair;
		}
		return null;
	}

	#fixInfoToTextEdit(fixInfo, diagnostic, document) {
		const lineNumber = fixInfo.lineNumber
			? fixInfo.lineNumber - 1
			: diagnostic.range.start.line;
		const editColumn = (fixInfo.editColumn || 1) - 1;
		const deleteCount = fixInfo.deleteCount || 0;
		const insertText = fixInfo.insertText || "";

		if (deleteCount === 0 && insertText === "") {
			this.#logger("Skipping no-op edit (no delete, no insert)");
			return null;
		}
		if (lineNumber < 0 || lineNumber >= document.lineCount) {
			this.#logger(
				`Skipping edit: line ${lineNumber} out of bounds (document has ${document.lineCount} lines)`,
			);
			return null;
		}
		if (editColumn < 0) {
			this.#logger(`Skipping edit: negative column ${editColumn}`);
			return null;
		}
		if (deleteCount < 0) {
			this.#logger(`Skipping edit: negative deleteCount ${deleteCount}`);
			return null;
		}

		const lineText = this.#getLineText(document, lineNumber);
		const lineLen = lineText.length;
		const startChar = Math.min(editColumn, lineLen);
		const endChar = Math.min(editColumn + deleteCount, lineLen);

		if (startChar === endChar && insertText === "") {
			this.#logger(
				`Skipping no-op edit after clamping (line ${lineNumber}, col ${startChar})`,
			);
			return null;
		}

		this.#logger(
			`Creating TextEdit: line ${lineNumber}, col ${startChar}-${endChar}, insert "${insertText}"`,
		);

		return TextEdit.replace(
			{
				start: { line: lineNumber, character: startChar },
				end: { line: lineNumber, character: endChar },
			},
			insertText,
		);
	}

	#getLineText(document, line) {
		if (line < 0 || line >= document.lineCount) {
			return "";
		}
		return document.getText({
			start: { line, character: 0 },
			end: { line, character: Number.MAX_SAFE_INTEGER },
		});
	}

	#rangesOverlap(range1, range2) {
		if (
			range1.end.line < range2.start.line ||
			(range1.end.line === range2.start.line &&
				range1.end.character <= range2.start.character)
		) {
			return false;
		}
		if (
			range2.end.line < range1.start.line ||
			(range2.end.line === range1.start.line &&
				range2.end.character <= range1.start.character)
		) {
			return false;
		}
		return true;
	}
}
