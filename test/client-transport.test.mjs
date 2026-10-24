import { expect } from "chai";
import { describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

function frame(message) {
	const body = Buffer.from(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "window/logMessage",
			params: { type: 3, message },
		}),
	);
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
		body,
	]);
}

describe("Test client message framing", () => {
	for (const fragmented of [false, true]) {
		it(`decodes Unicode and consecutive messages ${fragmented ? "one byte at a time" : "in one chunk"}`, async () => {
			const client = new TestLanguageClient();
			const raw = await client.start();
			try {
				await client.requestCodeActions("file:///unopened.md", {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
				});
				const messages = ["café 日本語 😊", "next message"];
				const bytes = Buffer.concat(messages.map(frame));
				const chunks = fragmented
					? Array.from(bytes, (byte) => Buffer.from([byte]))
					: [bytes];
				for (const chunk of chunks) {
					raw.process.stdout.emit("data", chunk);
				}
				expect(
					client.logMessages.slice(-2).map(({ message }) => message),
				).to.deep.equal(messages);
			} finally {
				raw.process.kill();
			}
		});
	}
});
