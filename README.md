# markdownlint-lsp

> ✨ **This project was entirely vibe coded!** ✨
> 
> *No formal planning was harmed in the making of this LSP server. Pure vibes only.*

[![npm version](https://img.shields.io/npm/v/markdownlint-lsp)](https://www.npmjs.com/package/markdownlint-lsp)
[![CI](https://github.com/vitallium/markdownlint-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/vitallium/markdownlint-lsp/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitallium/markdownlint-lsp/blob/main/LICENSE)

A Language Server Protocol (LSP) implementation for [markdownlint](https://github.com/DavidAnson/markdownlint), providing real-time linting for Markdown files in any editor that supports LSP.

## Installation

```bash
# Global installation
npm install -g markdownlint-lsp

# Or install locally for development
npm install markdownlint-lsp
```

This package uses [pnpm](https://pnpm.io/) as its package manager.

## Usage

The LSP server can be started directly:

```bash
markdownlint-lsp-server --stdio
```

Most LSP-compatible editors will automatically detect and use the server via the `package.json` `bin` entry. The server communicates over stdio and follows the standard LSP protocol.

## Configuration

The server supports hierarchical configuration loading, searching from the file being linted up to the workspace root. Configuration files are discovered in the following precedence order:

### CLI2-style Configuration
1. `.markdownlint-cli2.jsonc`
2. `.markdownlint-cli2.yaml` / `.markdownlint-cli2.yml`
3. `.markdownlint-cli2.cjs` / `.markdownlint-cli2.mjs`
4. `package.json` (with `markdownlint-cli2` key, workspace root only)

### Standard markdownlint Configuration
1. `.markdownlint.jsonc`
2. `.markdownlint.json`
3. `.markdownlint.yaml` / `.markdownlint.yml`
4. `.markdownlint.cjs` / `.markdownlint.mjs`

### RC-style Configuration
1. `.markdownlintrc`
2. `.markdownlint/config`

### Ignore Patterns

The `.markdownlintignore` file is also supported for ignoring specific files or directories, following standard `.gitignore` semantics. Bare directory names (e.g., `dist`) will recursively ignore everything under that directory.

### Example Configuration

```jsonc
{
  "extends": "default",
  "rules": {
    "MD013": false
  },
  "ignores": ["dist", "coverage"]
}
```

## Features

- **Real-time linting**: Immediate feedback as you edit Markdown files
- **Hierarchical configuration**: Configuration files are loaded from the document directory up to the workspace root
- **Multiple formats**: Supports JSON, YAML, and JavaScript configuration files
- **File watching**: Automatically re-validates all open documents when configuration files change
- **Full markdownlint compatibility**: Uses the [markdownlint](https://github.com/DavidAnson/markdownlint) library under the hood
- **RC-style configuration**: Follows npm rc package standards for `.markdownlintrc` files

## License

This project is licensed under the [MIT License](LICENSE).
