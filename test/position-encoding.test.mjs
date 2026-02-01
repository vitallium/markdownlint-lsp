import { expect } from "chai";
import { after, before, describe, it } from "mocha";
import { TestLanguageClient } from "./helpers.mjs";

describe("Position Encoding Negotiation", () => {
	let client;

	before(async () => {
		client = new TestLanguageClient({
			capabilities: {
				general: {
					positionEncodings: ["utf-8", "utf-16"],
				},
			},
		});
		await client.start();
	});

	after(async () => {
		await client.stop();
	});

	it("should prefer UTF-16 when supported", () => {
		expect(client.capabilities.positionEncoding).to.equal("utf-16");
	});
});
