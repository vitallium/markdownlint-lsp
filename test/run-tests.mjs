#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const watchMode = args.includes("--watch") || args.includes("-w");
const testFilter = args.find((arg) => !arg.startsWith("-")) || "";

const testFiles = {
	server: "test/server.test.mjs",
	config: "test/configuration.test.mjs",
	edge: "test/edge-cases.test.mjs",
	all: "test/**/*.test.mjs",
};

function getTestPattern() {
	if (testFilter && testFiles[testFilter]) {
		return testFiles[testFilter];
	}
	if (testFilter) {
		return `test/**/*${testFilter}*.test.mjs`;
	}
	return testFiles.all;
}

function runTests() {
	console.clear();
	console.log(`\n🧪 Running tests: ${getTestPattern()}\n`);

	const mocha = spawn("npx", ["mocha", getTestPattern(), "--color"], {
		cwd: projectRoot,
		stdio: "inherit",
		shell: true,
	});

	return new Promise((resolve) => {
		mocha.on("close", (code) => {
			if (code === 0) {
				console.log("\n✅ All tests passed!\n");
			} else {
				console.log(`\n❌ Tests failed with exit code ${code}\n`);
			}
			resolve(code);
		});
	});
}

async function runOnce() {
	const startTime = Date.now();
	await runTests();
	const elapsed = Date.now() - startTime;
	console.log(`⏱️  Test run completed in ${(elapsed / 1000).toFixed(2)}s`);
}

async function runWithWatch() {
	console.log("👁️  Watch mode enabled. Press Ctrl+C to exit.\n");

	// Initial run
	await runTests();

	// Watch for changes
	const watchDirs = [join(projectRoot, "lib"), join(projectRoot, "test")];

	const watchers = watchDirs.map((dir) => {
		console.log(`Watching: ${dir}`);
		return watch(dir, { recursive: true }, async (_, filename) => {
			if (
				filename &&
				(filename.endsWith(".mjs") || filename.endsWith(".json"))
			) {
				console.log(`\n📝 Change detected in ${filename}`);
				await runTests();
			}
		});
	});

	// Handle exit
	process.on("SIGINT", () => {
		console.log("\n\n👋 Stopping test watcher...");
		watchers.forEach((w) => {
			w.close();
		});
		process.exit(0);
	});
}

// Show usage
if (args.includes("--help") || args.includes("-h")) {
	console.log(`
Markdownlint LSP Test Runner

Usage:
  node test/run-tests.mjs [filter] [options]

Filters:
  server    Run server tests only
  config    Run configuration tests only
  edge      Run edge case tests only
  <pattern> Run tests matching pattern

Options:
  -w, --watch  Run tests in watch mode
  -h, --help   Show this help message

Examples:
  node test/run-tests.mjs              # Run all tests
  node test/run-tests.mjs server       # Run server tests
  node test/run-tests.mjs --watch      # Run all tests in watch mode
  node test/run-tests.mjs config -w    # Watch configuration tests
`);
	process.exit(0);
}

// Main execution
if (watchMode) {
	runWithWatch();
} else {
	runOnce();
}
