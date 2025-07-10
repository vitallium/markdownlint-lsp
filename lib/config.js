import path from "node:path";
import yaml from "js-yaml";
import { globby } from "globby";
import { readConfig as readMarkdownlintConfig } from "markdownlint/promise";

// The order of these filenames is important and reflects the precedence
// that markdownlint-cli2 uses for configuration files.
// See: https://github.com/DavidAnson/markdownlint-cli2#configuration
export const MARKDOWNLINT_CLI2_CONFIG_FILENAMES = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.yml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
  ".markdownlint.cjs",
  ".markdownlint.mjs",
  "package.json",
];

const PARSERS = [(content) => yaml.load(content)];

export async function readConfig(dir) {
  const foundFiles = await globby(MARKDOWNLINT_CLI2_CONFIG_FILENAMES, {
    cwd: dir,
    absolute: true,
    deep: 1,
    onlyFiles: true,
  });

  if (foundFiles.length === 0) {
    return null;
  }

  for (const filename of MARKDOWNLINT_CLI2_CONFIG_FILENAMES) {
    const matchedFile = foundFiles.find(
      (file) => path.basename(file) === filename,
    );

    if (matchedFile) {
      try {
        if (filename === "package.json") {
          const packageJson = await readMarkdownlintConfig(
            matchedFile,
            PARSERS,
          );
          const config = packageJson["markdownlint-cli2"];
          if (config) {
            console.log("Read config from package.json");
            return config;
          }
          // If no `markdownlint-cli2` key, we don't treat it as a config file.
          continue;
        }

        const config = await readMarkdownlintConfig(matchedFile, PARSERS);
        if (config) {
          console.log(`Read config from ${filename}`);
          return config;
        }
      } catch (error) {
        // Log the error and continue to the next file in case of a parsing error.
        console.error(`Error reading or parsing ${matchedFile}:`, error);
      }
    }
  }

  return null;
}
