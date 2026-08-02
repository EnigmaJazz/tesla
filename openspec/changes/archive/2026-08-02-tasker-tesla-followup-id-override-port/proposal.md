# Proposal: Port ID Parsing and Override Ownership

## Intent

Port—rather than merge—the stranded slice-3/4 identity and override-owner work onto current master. This closes the RULE-8A/PR-E2 ownership gap and implements ID-2/RULE-8C requirements: occurrence IDs are parsed and override resources have a writer.

## Scope

### In Scope
- Add `ID_Parser.js`; inline strict last-underscore/base-36 parsing in `Appender.js`, `Override_Injector.js`, and `Sandbox_Engine.js`, logging `ID_PARSE_REJECTED` on rejection.
- Add `Override_Handler.js` as sole writer of `TDS_Overrides.json` and new `TDS_Routine_Preferences.json`; migrate `Route_Defaults`/`Route_History`, use exact-key maps, and convert seven writers to command adapters.
- Move the four legacy memory arrays to documented ephemeral globals; update compatible read paths and port the two harness tests/ownership guard.

### Out of Scope
- AC-3/5/7, synthetic-return suppression, manual-return gating, and zero-duration work.
- Sandbox's ten `indexOf(evId)` membership checks (OVR-10 follow-up).

## Capabilities

### New Capabilities
None.

### Modified Capabilities
None; this implements existing `itinerary` ID-2, RULE-8C, and SCRIPT-15 requirements. Only the status evidence line changes.

## Approach

Port branch-tip semantics, re-anchored to master. `Override_Injector.js` SHALL use `readActiveGeneration('itinerary')`: this aligns it with Phase 2 and retains the resolver's legacy fallback, avoiding a second divergent read path. Handler commands SHALL use reducer-style Tasker staging: `par1` is the operation and `par2` is JSON payload; production adapters stage values for the next Handler action, while the harness supplies `handler(op, payload)`. This matches existing `Trip_State_Reducer` conventions without cross-script imports.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `ID_Parser.js`, `Override_Handler.js` | New | Canonical parser and sole resource writer. |
| `Alpha.js`, `Appender.js`, `Compiler.js`, `Default.js`, `Finaliser.js`, `Override_Injector.js`, `Stop_Logger.js` | Modified | Command adapters/global migration. |
| `Sandbox_Engine.js`, `harness/*`, `openspec/specs/itinerary/spec.md` | Modified | Parser/prefs readers, tests/guard, status evidence. |

**Review estimate:** 1,900–2,300 changed lines, including two adapted harness suites. This exceeds the 400-line budget; recommend chained PR slices during task planning.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Preference migration loses learned routes | Med | Test one-time migration and snapshot both files. |
| Manifest reader changes injector input | Low | Use `readActiveGeneration` legacy fallback and manifest fixtures. |
| Scope expands into Sandbox membership rewrite | Med | Keep OVR-10 checks explicitly deferred. |

## Rollback Plan

Snapshot override and preference files before deployment. Revert the port, restore the override snapshot, remove the new preference file, and restore legacy readers/adapters; do not alter published generations or trip state.

## Dependencies

- Existing Phase 2 manifest resolver and Phase 3 Tasker command-staging conventions.

## Success Criteria

- [ ] No scoped consumer writes either override resource; harness guard permits Handler only.
- [ ] IDs with underscore-containing cores parse; malformed/out-of-range suffixes log rejection.
- [ ] Preferences migrate once and override behavior remains compatible through manifest-backed injection.
