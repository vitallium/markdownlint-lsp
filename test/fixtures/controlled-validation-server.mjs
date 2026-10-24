import * as fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Server } from "../../lib/server.mjs";

// Exercise the real server queue while controlling validation completion.
let validationCount = 0;
class ControlledServer extends Server {
	async validateDocument(document) {
		const number = ++validationCount;
		const directory = path.dirname(fileURLToPath(document.uri));
		const marker = (name) => path.join(directory, `${name}-${number}`);
		fs.writeFileSync(
			marker("started"),
			JSON.stringify({ version: document.version }),
		);
		while (!fs.existsSync(marker("release"))) {
			await delay(5);
		}
		fs.writeFileSync(marker("completed"), "");
	}
}

new ControlledServer().listen();
