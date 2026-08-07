## Testing Capabilities

**Strict TDD Mode**: disabled
**Detected**: 2026-08-07

### Test Runner

- Command: `for f in harness/test_*.js; do node $f; done`
- Framework: none (plain Node + vm sandbox)

### Test Layers

| Layer       | Available | Tool        |
| ----------- | --------- | ----------- |
| Unit        | ✅        | node + harness/mock_tasker.js |
| Integration | ✅        | 28 cross-component harness tests |
| E2E         | ❌        | Tasker (manual execution) |

### Coverage

- Available: ❌
- Command: `—`

### Quality Tools

| Tool         | Available | Command        |
| ------------ | --------- | -------------- |
| Linter       | ❌        | —              |
| Type checker | ❌        | —              |
| Formatter    | ❌        | —              |

### Context

This is a Tasker Android automation project. The JavaScript runs inside Tasker's proprietary JSlet engine, not Node.js. There is no `package.json`, no `node_modules`, no linter, no type checker, and no formatter. There is no CI; testing runs locally in Node.

A deterministic Node harness lives at `harness/`: `mock_tasker.js` builds a `vm` sandbox mocking the Tasker primitives (`local`/`setLocal`/`global`/`setGlobal`/`readFile`/`writeFile`/`flash`) with pinned `Date.now`; `runner.js` loads a production script into that sandbox; `day_utils.js` holds the shared DST-safe day-boundary helpers. The suite is 28 scripts under `harness/test_*.js`, run with `for f in harness/test_*.js; do node $f; done`. Scripts are exercised with synthetic data through their side effects; device flows (serial `par1`/`par2` staging, `%`-expansion) remain manual-only in Tasker.
