import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect } from "chai";
import { describe, it } from "mocha";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

describe("Package executable", () => {
	const isWindows = process.platform === "win32";

	(isWindows ? it.skip : it)("starts from the packed bin target", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "markdownlint-lsp-"),
		);
		const packageDir = path.join(tempDir, "package");
		let server;

		try {
			await fs.mkdir(packageDir);
			await Promise.all([
				fs.cp(path.join(projectRoot, "lib"), path.join(packageDir, "lib"), {
					recursive: true,
				}),
				...["LICENSE", "README.md", "package.json"].map((file) =>
					fs.copyFile(
						path.join(projectRoot, file),
						path.join(packageDir, file),
					),
				),
			]);

			const pack = spawn(
				"pnpm",
				["pack", "--pack-destination", tempDir, "--silent"],
				{
					cwd: packageDir,
				},
			);
			const [packExitCode] = await once(pack, "exit");
			expect(packExitCode).to.equal(0);

			const tarball = (await fs.readdir(tempDir)).find((file) =>
				file.endsWith(".tgz"),
			);
			expect(tarball).to.exist;

			const prefix = path.join(tempDir, "prefix");
			const install = spawn("npm", [
				"install",
				"--prefix",
				prefix,
				"--global",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				path.join(tempDir, tarball),
			]);
			const [installExitCode] = await once(install, "exit");
			expect(installExitCode).to.equal(0);

			const entryPoint = path.join(
				prefix,
				"lib",
				"node_modules",
				"markdownlint-lsp",
				"lib",
				"index.mjs",
			);
			await fs.chmod(entryPoint, 0o755);
			server = spawn(entryPoint, ["--stdio"]);
			const exit = once(server, "exit").then(([code]) => {
				throw new Error(`The package executable exited with code ${code}`);
			});
			const request = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { capabilities: {} },
			});
			server.stdin.write(
				`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
			);
			const response = once(server.stdout, "data").then(([data]) =>
				data.toString(),
			);

			const output = await Promise.race([
				response,
				exit,
				delay(1000).then(() => {
					throw new Error("The package executable did not respond");
				}),
			]);
			expect(output).to.include("Content-Length:");
		} finally {
			server?.kill();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
