# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] - 2025-10-26

### Features

- Implement code actions
- Resolve root path from workspace folders

### Bug Fixes

- Register workspace folder handlers after capabilities are set
- Use correct workspace root for each document
- Prevent stale diagnostics with version tracking
- Skip config loading for non-file URIs
- Clamp text edits to line bounds
- Watch package.json for config changes
- Correct config precedence order
- Clear stale diagnostics when validation fails
- Clean up config cache on document close
- Use path.relative for robust workspace root detection
- Guard config merge when settings missing
- Treat workspace roots as valid subdirectories

### Refactor

- Remove unused #getWorkspaceRoot method
- Centralize root path resolution

### Documentation

- Remove non-existent test references from AGENTS.md

### Performance

- Throttle validation on open and change events
- Cache config loading results
- Prevent duplicate validation on document save
- Debounce config file change events
- Increase config change debounce from 100ms to 300ms

### Testing

- Add comprehensive behavior tests for markdownlint LSP server

### Miscellaneous Tasks

- Add CHANGELOG.md
- *(deps)* Update markdownlint to v0.39.0
- Add Zed settings
- Add AGENTS.md file
- Remove unused globby dependency
- Remove empty onWillSave handler
- *(server)* Remove redundant comments
- *(agents)* Add note about pnpm package manager
- *(agents)* Wrap long lines in AGENTS.md

## [0.5.1] - 2025-09-18

### Bug Fixes

- *(scripts)* Correct main entry point from index.js to index.mjs
- *(lsp)* Check workspace folders capability properly
- *(lsp)* Prevent validation of closed documents
- *(lsp)* Implement tracing correctly

### Refactor

- *(lsp)* Use fileURLToPath for proper URI handling

### Styling

- Run biome again

### Miscellaneous Tasks

- *(deps)* Update `@biomejs/biome` to v2.2.4
- Bump version to 0.5.1

## [0.5.0] - 2025-07-18

### Features

- Add willSave handler to LSP server
- Add didSave handler to LSP server
- Add explicit position encoding support to LSP server
- Add throttling for didSave validation

### Styling

- Format code with biome

### Miscellaneous Tasks

- Bump version to 0.5.0

## [0.4.0] - 2025-07-17

### Features

- Add support for RC-style configuration files

### Bug Fixes

- Improve configuration file watching and CLI2 compliance

### Miscellaneous Tasks

- Bump version to 0.4.0

## [0.3.0] - 2025-07-11

### Features

- Support nested configurations

### Documentation

- Add vibe coded warning to README

## [0.2.0] - 2025-07-10

### Features

- *(config)* Add support for markdownlint-cli2 configs
- Add workspace folder support
- Implement config caching for better performance
- Replace console logging with proper LSP tracer

### Miscellaneous Tasks

- Switch to pnpm
- Add biome

