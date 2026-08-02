# Tasks: Port ID Parsing and Override Ownership

## Chained PR Slices

Each slice targets the preceding slice, is independently testable, and is revertible at its listed files. Keep authored additions plus deletions under 400 lines per slice.

### Slice A — Parser foundation (PR A)
- [x] **A1.** Add `ID_Parser.js` and inline identical last-underscore/base-36 parsing plus `ID_PARSE_REJECTED` logging at `Appender.js:90`, `Override_Injector.js:100`, and `Sandbox_Engine.js:1026`; rejected IDs skip work (ID-2 scenarios Valid, Invalid, Rejection logging). Files: those four scripts.
- [x] **A2.** Port/adapt `harness/test_id_parsing.js`, including underscore-core, bounds, malformed, rejection-log, and substring-decoy fixtures; run `for f in harness/test_*.js; do node "$f"; done`. Files: `harness/test_id_parsing.js`.

### Slice B — Handler shell and persistence (PR B)
- [ ] **B1.** Create `Override_Handler.js` with `par1` command dispatch, schema-v2 OVR/PREFS stores, exact-key helpers, and four-hour/24-hour/12-hour retention boundaries (CMD-9, OVR-10, PRUNE scenario). File: `Override_Handler.js`.
- [ ] **B2.** Implement one-time legacy preference migration, PREFS-first/read-back deployment, exact snapshot restoration or deletion on failure, and rollback tests using torn-write injection (Protected Preference Migration scenarios). Files: `Override_Handler.js`, `harness/test_single_writer.js`.

### Slice C — Operations and projections (PR C)
- [ ] **C1.** Add RED/verification coverage for `APPLY_OVERRIDE`, `APPEND_OVERRIDE`, `SET_DEFAULT`, `PRUNE`, exact-key decoys, projections, and global-array pruning (Serialized Override Command API scenarios).
- [ ] **C2.** Implement all four operations; **APPLY_OVERRIDE MUST toggle the exact key and remove only exact conflicting-category keys via `exactKeyRemove`/`categorizedWipe`**, while preserving compatible history/default projections (CMD-9, OVR-10). File: `Override_Handler.js`.

### Slice D — Primary adapters (PR D)
- [ ] **D1.** Convert `Alpha.js`, `Appender.js`, `Default.js`, and `Override_Injector.js` to staged Handler commands; switch Injector to `readActiveGeneration('itinerary')` with legacy fallback and preserve UI rerun behavior (RULE-8C, PUB-7; manifest-backed injection). Files: four adapters.
- [ ] **D2.** Extend harness command fixtures for adapter staging and manifest input; run full harness suite. Files: `harness/test_id_parsing.js`, `harness/test_single_writer.js`.

### Slice E — Globals and remaining readers (PR E)
- [ ] **E1.** Convert `Compiler.js`, `Finaliser.js`, and `Stop_Logger.js` to documented transient globals while retaining publisher/reducer commands; update `Sandbox_Engine.js` readers to globals/PREFS without touching deferred OVR-10 membership checks (RULE-8C, SCRIPT-15). Files: four scripts.
- [ ] **E2.** Test four globals, reducer interaction, and Sandbox PREFS/Completed Stops reads; run `for f in harness/test_*.js; do node "$f"; done`. Files: `harness/test_single_writer.js`.

### Slice F — Ownership proof and evidence (PR F)
- [ ] **F1.** Add `OVERRIDE_HANDLER_PATH`, OVR/PREFS unauthorized-write guards, `handler()` staging, and `__currentScriptPath` support to `harness/mock_tasker.js`; sweep all seven former writers for direct writes and preserve `TDS_Helper.js` read-only status (RULE-8C scenario Seven-writer ownership guard). Files: mock and affected adapters.
- [ ] **F2.** Run the existing 15 tests plus both ported suites, then update only verified scoped status evidence for ID-2/RULE-8C/SCRIPT-15; retain AC-3/5/7, synthetic/manual returns, zero-duration, and Sandbox OVR-10 exclusions (VAL-18). File: `openspec/specs/itinerary/spec.md`.

## Review Workload Forecast

Chained PRs recommended: Yes
400-line budget risk: Low
Estimated changed lines: ~1,900-2,260 total; ~280-390 per slice
Decision needed before apply: Yes
Delivery strategy: ask-on-risk; six sequential slices, each with focused harness verification and rollback at its slice files/behavior.
