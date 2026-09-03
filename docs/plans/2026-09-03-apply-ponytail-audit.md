---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
title: Apply Ponytail audit cleanup
created_at: 2026-09-03
---

# Apply Ponytail audit cleanup

## Goal Capsule

- **Objective:** Maintainers can run and understand the test suite without unused test utilities or duplicate test-launching code.
- **Means:** Delete unused helpers and the custom Mocha wrapper, while retaining the package scripts that map directly to Mocha. (KTD1)
- **Authority:** Apply the user-approved Ponytail audit findings only; do not change LSP behavior or dependencies.
- **Stop conditions:** The test suite and Biome check pass with no new warnings.
- **Tail ownership:** The implementation workflow owns review, commit, and PR creation.

---

## Product Contract

### Summary

Remove test-only code that has no consumers and replace the custom test launcher with the existing direct Mocha scripts.

### Problem Frame

The repository carries a dead rule map and delay helper, plus a custom test runner that duplicates Mocha's normal run and watch capabilities.

### Requirements

- R1. Remove the unused `wait` helper and `markdownlintRules` map from test support code.
- R2. Remove the custom test runner and its package-script entry points.
- R3. Preserve direct test, watch, and focused-suite commands.
- R4. Simplify the cache-key URI check with optional chaining without changing its result.

### Scope Boundaries

- No LSP runtime behavior, dependencies, or test assertions change.
- No replacement test runner is introduced.

## Planning Contract

- KTD1. **Use Mocha directly.** `test`, `test:watch`, and focused test scripts already expose the needed operations; keep those scripts and delete the wrapper. (session-settled: user-approved; chosen over retaining the duplicate runner. Governs R2, R3)
- KTD2. **Keep cache-key behavior unchanged.** Replace only the equivalent null-safe predicate. Governs R4.

### Assumptions

- Focused test selection beyond the existing named suites can use Mocha arguments through `pnpm test`.

### Sequencing

Apply deletion first, then the one-line cache-key simplification, then run static checks and tests.

## Implementation Units

### U1. Remove unused test support and runner

- **Goal:** Keep only test helpers and launch paths that repository tests use.
- **Requirements:** R1, R2, R3.
- **Files:** `test/helpers.mjs`, `test/run-tests.mjs`, `package.json`.
- **Approach:** Delete the two unreferenced exports, delete the runner file, and remove only `test:runner` and `test:dev`; retain direct Mocha scripts.
- **Test scenarios:** The complete Mocha suite starts from `pnpm test`; watch and focused-suite package scripts remain valid script definitions.
- **Verification:** `pnpm test` and `pnpm exec biome check .`.

### U2. Simplify the cache-key URI guard

- **Goal:** Express the existing missing-or-non-file URI branch directly.
- **Requirements:** R4.
- **Files:** `lib/cache-keys.mjs`.
- **Approach:** Use optional chaining in the file-scheme predicate; preserve fallback and conversion behavior.
- **Test scenarios:** Existing cache-key tests still cover file and non-file URI keys.
- **Verification:** `pnpm test` and `pnpm exec biome check .`.

## Verification Contract

| Command | Applies to | Done signal |
| --- | --- | --- |
| `pnpm exec biome check .` | U1, U2 | No diagnostics. |
| `pnpm test` | U1, U2 | All tests pass. |

## Definition of Done

- U1 removes only unused test support and the duplicate runner surface.
- U2 preserves cache-key results for file and non-file URIs.
- Static checks and the full test suite pass.
- The diff contains no abandoned replacement runner or unrelated cleanup.
