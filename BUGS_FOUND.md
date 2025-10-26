# Bugs Found During LSP Testing

This document lists the bugs discovered while writing behavior tests for the markdownlint Language Server Protocol implementation.

## 🔴 Critical Issues

### 1. MD011 Rule Not Detected
**Test:** `server.test.mjs - should publish diagnostics for documents with errors`
- **Expected:** MD011 (no-reversed-links) should be detected for `[reversed link][text]` syntax
- **Actual:** Rule is not triggered
- **Impact:** Users won't get warnings for reversed link syntax

### 2. False Positives on Clean Documents
**Test:** `server.test.mjs - should not publish diagnostics for clean documents`
- **Expected:** Clean markdown files should have 0 diagnostics
- **Actual:** 1 diagnostic reported on clean file
- **Impact:** Users see errors on valid markdown

## 🟡 Configuration Issues

### 3. Configuration File Loading Failures
**Tests:** Multiple configuration tests
- **Affected formats:**
  - `.markdownlint.json` - rules not properly disabled
  - `.markdownlint.jsonc` - comments not parsed
  - `.markdownlint.yaml` / `.markdownlint.yml` - not loaded
  - `.markdownlintrc` - not recognized
  - `package.json` with `markdownlint-cli2` key - not loaded
- **Impact:** Users can't configure the linter behavior

### 4. MD033 allowed_elements Not Working
**Test:** `server.test.mjs - should allow HTML elements specified in configuration`
- **Expected:** Only disallowed HTML elements trigger MD033
- **Actual:** All HTML elements trigger the rule despite configuration
- **Example:** `allowed_elements: ["br", "hr"]` still flags `<br>` tags

### 5. Configuration Precedence Issues
**Test:** `configuration.test.mjs - should respect configuration precedence`
- **Expected:** CLI2 configs should override standard configs
- **Actual:** Configuration precedence not properly implemented
- **Impact:** Unexpected rule behavior when multiple configs exist

## 🟠 Multi-Document & Performance Issues

### 6. Multi-Document Timeout
**Test:** `server.test.mjs - should handle multiple open documents independently`
- **Expected:** Multiple documents handled without issues
- **Actual:** Timeout waiting for diagnostics on second document
- **Impact:** LSP fails with multiple open files

### 7. Incremental Update Problems
**Test:** `edge-cases.test.mjs - should handle line deletions`
- **Expected:** Deleting lines should clear related diagnostics
- **Actual:** MD012 (multiple-blanks) persists after fixing
- **Impact:** Stale diagnostics shown to users

### 8. Rapid Change Handling
**Test:** `edge-cases.test.mjs - should debounce rapid consecutive changes`
- **Expected:** Rapid typing should be handled gracefully
- **Actual:** Timeout waiting for diagnostics
- **Impact:** Poor performance during active editing

### 9. Multi-line Paste Detection
**Test:** `edge-cases.test.mjs - should handle multi-line paste operations`
- **Expected:** All errors in pasted content detected
- **Actual:** Some errors missed (only 3 detected instead of 4+)
- **Impact:** Incomplete error reporting

## 🟢 Working Features

The following features are working correctly:
- Basic server initialization
- Simple document diagnostics
- Individual rule detection (most rules)
- Unicode and emoji handling
- Large document handling
- Error recovery from malformed content
- Diagnostic range calculation

## Reproduction Steps

1. Install test dependencies:
   ```bash
   pnpm install
   ```

2. Run specific test suites:
   ```bash
   npm run test:server  # Core functionality tests
   npm run test:config  # Configuration tests
   npm run test:edge    # Edge case tests
   ```

3. Check individual failing tests for specific reproduction cases

## Priority Recommendations

1. **High Priority**
   - Fix configuration loading system (affects all users)
   - Fix MD011 detection (missing rule)
   - Fix false positives on clean files

2. **Medium Priority**
   - Fix multi-document handling
   - Implement proper debouncing
   - Fix incremental updates

3. **Low Priority**
   - Optimize performance for edge cases
   - Add file watching capabilities