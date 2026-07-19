## Testing Capabilities

**Strict TDD Mode**: disabled
**Detected**: 2026-07-19

### Test Runner

- Command: `none`
- Framework: none — manual execution in Tasker environment

### Test Layers

| Layer       | Available | Tool        |
| ----------- | --------- | ----------- |
| Unit        | ❌        | —           |
| Integration | ❌        | —           |
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

This is a Tasker Android automation project. The JavaScript runs inside Tasker's proprietary JSlet engine, not Node.js. There is no `package.json`, no `node_modules`, no test framework, no linter, no type checker, and no formatter. All testing is done by running the scripts in Tasker and inspecting the output JSON files (Itin_Master.json, TDS_Overrides.json, etc.) or by reading `local()`/`global()` variable dumps.

A deterministic scenario harness could be created as a standalone JS file that mocks the Tasker APIs — this is a potential improvement for a future change.
