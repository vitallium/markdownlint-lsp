# Changelog

All notable changes to this project will be documented in this file.

## [0.10.0] - 2026-09-24

### Features

- Log config loading outcomes

### Bug Fixes

- _(config)_ Parse JSONC comments
- Apply client settings on cold start
- _(ci)_ Avoid yielding when startup settings are absent
- Preserve code action lookup semantics

### Performance

- _(code-actions)_ Use Map for O(1) diagnostic fix pair lookup

### Styling

- Apply formatting

### Miscellaneous Tasks

- Update `js-yaml` to v5.4.2

## [0.9.2] - 2026-09-03

### Bug Fixes

- Load both markdownlint-cli2 and markdownlint configs when both present
- Make packaged server executable
- Mark `lib/index.mjs` as executable
- Address linting issues in IgnorePatternSet refactor

### Refactor

- _(document-runtime)_ Consolidate per-URI state into DocumentState class
- _(ignore)_ Create unified IgnorePatternSet for consolidated ignore matching

### Documentation

- Overhaul README with installation, usage, configuration, and features

### Miscellaneous Tasks

- _(deps)_ Update pnpm to v11.18.0
- Remove redundant test tooling
- Release 0.9.2

## [0.9.1] - 2026-08-01

### Bug Fixes

- Resolve race condition in validation queue

### Miscellaneous Tasks

- Release v0.9.1

## [0.9.0] - 2026-07-31

### Features

- _(server)_ Support .markdownlintignore files

### Bug Fixes

- _(server)_ Normalize relative paths to forward slashes for minimatch
- _(server)_ Recursively match bare directory names in ignores patterns

### Miscellaneous Tasks

- Stop testing on Node.js v20
- _(deps)_ Update markdownlint to v0.41.0
- Pin GitHub actions to SHAs to prevent tag hijacking
- _(deps)_ Update js-yaml to v5.2.1
- Add Biome linting job to CI workflow
- _(deps)_ Update `mocha` to v11.7.6
- _(deps)_ Update `biome` to v2.5.3
- _(deps)_ Update `markdownlint` to v0.41.1
- _(deps)_ Update biome to v2.5.5
- _(deps)_ Update ignore to v7.0.6
- _(deps)_ Update js-yaml to v5.2.2
- Release 0.9.0

## [0.8.0] - 2026-05-10

### Features

- _(server)_ Respect ignores glob patterns from config

### Bug Fixes

- _(server)_ Restore ignores precedence and settings support
- _(config)_ Require opt-in for JavaScript configs
- _(server)_ Register workspace folder updates
- _(server)_ Prefer nested workspace roots
- _(server)_ Clear ignored document fixes

### Refactor

- _(server)_ Split lifecycle and validation services

### Testing

- Harden diagnostics waiting in test client
- Isolate configuration state in integration tests

### Miscellaneous Tasks

- _(deps)_ Update biome to v2.4.6
- _(deps)_ Update biome to v2.4.7
- _(deps)_ Update minimatch to v10.2.5
- Release v0.8.0

## [0.7.0] - 2026-02-15

### Features

- Implement proper LRU cache for config loading
- Add "Fix All" code action with overlap handling

### Bug Fixes

- Initialization options should override project configs
- Add URI validation to prevent server crashes
- Prevent stale validations from pending timeouts
- Clear stale code action fixes on lint errors
- Provide quick fixes when diagnostics missing
- Guard config trace logging
- _(server)_ Negotiate position encodings
- _(server)_ Queue validations
- _(server)_ Merge initialization settings
- _(server)_ Key config cache by directory
- _(config)_ Redact sensitive logs
- _(config)_ Load js configs
- _(server)_ Apply fix-all edits

### Styling

- Run biome

### Testing

- Fix race condition

### Miscellaneous Tasks

- Remove .npmignore
- Remove testing documentation files
- Wrap README description to 72 characters
- _(deps)_ Bump `@biomejs/biome` to v2.3.2
- _(deps)_ Update `js-yaml` to v4.1.1
- Add `lint` and `lint:fix` tasks
- Initial setup
- _(deps)_ Update `chai` to v6.2.2
- _(deps)_ Update `markdownlint` to v0.40.0
- _(deps)_ Remove redundant pkgs from dev deps
- _(deps)_ Enable `pnpm` via corepack
- Remove `pnpm` version
- Log skipped fix-all overlaps
- Release v0.7.0

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
- _(deps)_ Update markdownlint to v0.39.0
- Add Zed settings
- Add AGENTS.md file
- Remove unused globby dependency
- Remove empty onWillSave handler
- _(server)_ Remove redundant comments
- _(agents)_ Add note about pnpm package manager
- _(agents)_ Wrap long lines in AGENTS.md
- _(release)_ V0.6.0

## [0.5.1] - 2025-09-18

### Bug Fixes

- _(scripts)_ Correct main entry point from index.js to index.mjs
- _(lsp)_ Check workspace folders capability properly
- _(lsp)_ Prevent validation of closed documents
- _(lsp)_ Implement tracing correctly

### Refactor

- _(lsp)_ Use fileURLToPath for proper URI handling

### Styling

- Run biome again

### Miscellaneous Tasks

- _(deps)_ Update `@biomejs/biome` to v2.2.4
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

- _(config)_ Add support for markdownlint-cli2 configs
- Add workspace folder support
- Implement config caching for better performance
- Replace console logging with proper LSP tracer

### Miscellaneous Tasks

- Switch to pnpm
- Add biome
