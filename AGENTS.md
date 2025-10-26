# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

This is a Language Server Protocol (LSP) implementation for markdownlint that provides real-time linting for Markdown files in editors and IDEs.

## Architecture

### Core Components

- **`lib/server.mjs`** - Main LSP server implementation
- **`lib/config.mjs`** - Configuration loading and management
- **`lib/merge-options.mjs`** - Configuration merging utilities
- **`lib/index.mjs`** - Entry point

### Key Features

- Real-time Markdown linting using `markdownlint`
- Hierarchical configuration loading
- File watching for configuration changes
- Support for multiple configuration formats

## Configuration System

### Supported Configuration Files (in precedence order)

#### CLI2-style Configuration

1. `.markdownlint-cli2.jsonc`
2. `.markdownlint-cli2.yaml`
3. `.markdownlint-cli2.yml`
4. `.markdownlint-cli2.cjs`
5. `.markdownlint-cli2.mjs`
6. `package.json` (with `markdownlint-cli2` key, workspace root only)

#### Standard markdownlint Configuration

1. `.markdownlint.jsonc`
2. `.markdownlint.json`
3. `.markdownlint.yaml`
4. `.markdownlint.yml`
5. `.markdownlint.cjs`
6. `.markdownlint.mjs`

#### RC-style Configuration (following npm rc package standards)

1. `.markdownlintrc`
2. `.markdownlint/config`

### Configuration Loading Logic

- Searches from the file being linted up to the workspace root
- CLI2 configs are merged using `mergeOptions`
- Standard markdownlint configs override parent configs (set as `config` property)
- RC-style configs follow markdownlint behavior (set as `config` property)

### File Watching

All configuration files are watched for changes, triggering re-validation of all open documents.

## Development Notes

### Dependencies

- `markdownlint` - Core linting functionality
- `vscode-languageserver` - LSP implementation
- `js-yaml` - YAML parsing for configuration files

### Build & Development

- Project uses ES modules (`.mjs` files)
- Entry point: `lib/index.mjs`
- Binary: `markdownlint-lsp-server`

## Development Commands

This project uses [pnpm](https://pnpm.io/) for package management.

### Running the LSP Server

```bash
# Start the LSP server
node lib/index.mjs --stdio

# Or using the package.json script
npm start
```

### Code Quality

```bash
# Format code with Biome
npx biome format --write .

# Check formatting
npx biome check .

# Run linting
npx biome lint .
```

## LSP Server Implementation Details

### Initialization

- Detects client capabilities (workspace folders, file watching)
- Sets up file watchers for configuration files
- Registers for document events

### Document Validation

- Triggered on document open, change, and configuration file changes
- Loads configuration for each document individually
- Sends diagnostics back to client

### Error Handling

- Graceful handling of missing configuration files
- Proper error reporting for malformed configurations
- Fallback to default configuration when needed

## References

- [markdownlint](https://github.com/DavidAnson/markdownlint)
- [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2)
- [markdownlint-cli](https://github.com/igorshubovych/markdownlint-cli)
- [rc package standards](https://www.npmjs.com/package/rc)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/)
