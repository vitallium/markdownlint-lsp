import { expect } from "chai";
import { describe, it } from "mocha";
import { DocumentRuntime } from "../lib/document-runtime.mjs";
import { PositionCodec } from "../lib/position-codec.mjs";

describe("Sequential content change conversion", () => {
	for (const encoding of ["utf-8", "utf-32", "utf-16"]) {
		describe(encoding, () => {
			const character = encoding === "utf-8" ? "é" : "😀";
			const width = encoding === "utf-32" ? 1 : 2;
			const range = (line, start, end) => ({
				start: { line, character: start },
				end: { line, character: end },
			});

			const cases = [
				{
					name: "uses inserted Unicode when converting the next range",
					text: "ab",
					changes: [
						{ range: range(0, 0, 0), text: character },
						{ range: range(0, width + 1, width + 2), text: "x" },
					],
					expected: `${character}ax`,
				},
				{
					name: "uses lines inserted by earlier changes",
					text: "ab",
					changes: [
						{ range: range(0, 0, 0), text: `heading\n${character}` },
						{ range: range(1, width + 1, width + 2), text: "x" },
					],
					expected: `heading\n${character}ax`,
				},
				{
					name: "uses lines joined by earlier changes",
					text: `${character}\nab`,
					changes: [
						{
							range: {
								start: { line: 0, character: width },
								end: { line: 1, character: 0 },
							},
							text: "",
						},
						{ range: range(0, width + 1, width + 2), text: "x" },
					],
					expected: `${character}ax`,
				},
				{
					name: "uses full-text replacements before incremental changes",
					text: "old",
					changes: [
						{ text: `heading\n${character}ab` },
						{ range: range(1, width + 1, width + 2), text: "x" },
					],
					expected: `heading\n${character}ax`,
				},
			];

			for (const { name, text, changes, expected } of cases) {
				it(name, () => {
					const codec = new PositionCodec();
					codec.setEncoding(encoding);
					const runtime = new DocumentRuntime(0);
					const original = runtime.open({
						uri: "file:///sequential.md",
						languageId: "markdown",
						version: 1,
						text,
					});
					const input = structuredClone(changes);

					const converted = codec.convertContentChangesToUtf16(
						changes,
						original,
					);

					expect(original.getText()).to.equal(text);
					expect(original.version).to.equal(1);
					expect(runtime.hasLatestVersion(original.uri, 1)).to.equal(true);
					expect(changes).to.deep.equal(input);
					if (encoding === "utf-16") {
						expect(converted).to.equal(changes);
					}

					const updated = runtime.update(
						{ uri: original.uri, version: 7 },
						converted,
					);
					expect(updated.getText()).to.equal(expected);
					expect(updated.version).to.equal(7);
					expect(runtime.hasLatestVersion(original.uri, 7)).to.equal(true);
					expect(runtime.hasLatestVersion(original.uri, 1)).to.equal(false);
				});
			}
		});
	}
});
