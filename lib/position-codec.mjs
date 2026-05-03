import { PositionEncodingKind } from "vscode-languageserver/node.js";

export class PositionCodec {
	#positionEncoding = PositionEncodingKind.UTF16;

	setEncoding(positionEncoding) {
		this.#positionEncoding = positionEncoding;
	}

	getEncoding() {
		return this.#positionEncoding;
	}

	isUtf16() {
		return this.#positionEncoding === PositionEncodingKind.UTF16;
	}

	convertContentChangesToUtf16(contentChanges, document) {
		return contentChanges.map((change) => {
			if (!change.range) {
				return change;
			}
			return {
				...change,
				range: this.convertRangeToUtf16(change.range, document),
			};
		});
	}

	convertDiagnosticsFromUtf16(diagnostics, document) {
		if (this.isUtf16()) {
			return diagnostics;
		}
		return diagnostics.map((diagnostic) =>
			this.convertDiagnosticFromUtf16(diagnostic, document),
		);
	}

	convertDiagnosticFromUtf16(diagnostic, document) {
		if (this.isUtf16()) {
			return diagnostic;
		}
		return {
			...diagnostic,
			range: this.convertRangeFromUtf16(diagnostic.range, document),
		};
	}

	convertDiagnosticToUtf16(diagnostic, document) {
		if (this.isUtf16()) {
			return diagnostic;
		}
		return {
			...diagnostic,
			range: this.convertRangeToUtf16(diagnostic.range, document),
		};
	}

	convertTextEditFromUtf16(textEdit, document) {
		if (this.isUtf16()) {
			return textEdit;
		}
		return {
			...textEdit,
			range: this.convertRangeFromUtf16(textEdit.range, document),
		};
	}

	convertRangeToUtf16(range, document) {
		if (this.isUtf16()) {
			return range;
		}
		return {
			start: this.convertPositionToUtf16(range.start, document),
			end: this.convertPositionToUtf16(range.end, document),
		};
	}

	convertRangeFromUtf16(range, document) {
		if (this.isUtf16()) {
			return range;
		}
		return {
			start: this.convertPositionFromUtf16(range.start, document),
			end: this.convertPositionFromUtf16(range.end, document),
		};
	}

	convertPositionToUtf16(position, document) {
		if (this.isUtf16()) {
			return position;
		}
		const lineText = this.#getLineText(document, position.line);
		if (this.#positionEncoding === PositionEncodingKind.UTF8) {
			return {
				line: position.line,
				character: this.#utf8IndexToUtf16(lineText, position.character),
			};
		}
		return {
			line: position.line,
			character: this.#utf32IndexToUtf16(lineText, position.character),
		};
	}

	convertPositionFromUtf16(position, document) {
		if (this.isUtf16()) {
			return position;
		}
		const lineText = this.#getLineText(document, position.line);
		if (this.#positionEncoding === PositionEncodingKind.UTF8) {
			return {
				line: position.line,
				character: this.#utf16IndexToUtf8(lineText, position.character),
			};
		}
		return {
			line: position.line,
			character: this.#utf16IndexToUtf32(lineText, position.character),
		};
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

	#utf16IndexToUtf8(text, index) {
		if (index <= 0) {
			return 0;
		}
		return Buffer.from(text.slice(0, index), "utf8").length;
	}

	#utf8IndexToUtf16(text, index) {
		if (index <= 0) {
			return 0;
		}
		let utf8Count = 0;
		let utf16Index = 0;
		for (const char of text) {
			const charSize = Buffer.from(char, "utf8").length;
			if (utf8Count + charSize > index) {
				break;
			}
			utf8Count += charSize;
			utf16Index += char.length;
		}
		return Math.min(utf16Index, text.length);
	}

	#utf16IndexToUtf32(text, index) {
		if (index <= 0) {
			return 0;
		}
		let count = 0;
		let seen = 0;
		for (const char of text) {
			if (seen + char.length > index) {
				break;
			}
			seen += char.length;
			count += 1;
		}
		return count;
	}

	#utf32IndexToUtf16(text, index) {
		if (index <= 0) {
			return 0;
		}
		let count = 0;
		let utf16Index = 0;
		for (const char of text) {
			if (count >= index) {
				break;
			}
			count += 1;
			utf16Index += char.length;
		}
		return Math.min(utf16Index, text.length);
	}
}
