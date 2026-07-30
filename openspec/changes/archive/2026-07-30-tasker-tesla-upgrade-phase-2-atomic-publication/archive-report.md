# Archive Report: tasker-tesla-upgrade-phase-2-atomic-publication

**Date:** 2026-07-30
**Status:** ARCHIVED
**Change:** Phase 2 — Atomic Publication
**Final Master SHA:** `452d515c887d3063f624638dcc01295cdaba68c6`

## Goal

Phase 2 made a validated generation the indivisible publication unit for the Tesla scheduler. It introduced a dedicated `Generation_Publisher.js` as the sole commit boundary, replaced direct master writes with staged candidates and manifest-last atomic publication, converted all readers to manifest-declared discovery with committed-state fallback, and hardened manual entry points (`Depart_Now.js`, `Return_to_Base.js`) into command adapters. The change added 10 new spec requirements (generation identity, lifecycle, schema, naming, discovery, propagation, retention, migration, RULE-8A remediation) and modified PUB-7 and OWN-8 to reflect versioned resources and committed-only data access.

## Final State

| Metric | Value |
|--------|-------|
| Baseline harness tests | 9 / 9 PASS |
| Spec scenarios covered | 29 / 30 |
| Testability gaps | 1 documented skip (restart-global restart test) |
| CRITICAL findings | 0 |
| Pre-existing WARNINGs out of scope | 3 |
| Master SHA | `452d515c887d3063f624638dcc01295cdaba68c6` |
| Merge base (PR-E1) | `37798706167b5a02cad4b904ebb6d133fb51e180` |

All 9 harness tests pass on the final master. The 29/30 scenario coverage reflects one intentional testability skip (the restart-global scenario cannot be asserted without process lifecycle hooks in the VM sandbox). The 0 CRITICALs reflect the complete remediation of the 10 CRITICAL findings documented in the initial verify report: partial-generation activation, missing validation gates, non-committed reader acceptance, incomplete reader cutover, manual-action bypasses, retained-ID collision, failed-candidate identity loss, UTC day-boundary, pre-existing AGENTS.md violations, and insufficient scenario coverage.

## Chain Summary

| PR | Merge SHA | Scope Summary | Total Δ |
|----|-----------|---------------|--------:|
| PR-A (#1) | `9716740` | Publisher skeleton, identity/manifest, failure/order tests, PUBLISH impl, migration/retention, read-only resolver, TDS_Helper, partial verification | +357 / −27 (384) |
| PR-B (#2) | `e3595c8` | Compiler/Finaliser hand-off to Publisher, reader cutover (Dispatcher, Dashboard, Sandbox), legacy fallback, integration tests | +347 / −34 (381) |
| PR-C (#3) | `bde38b4` | Gatekeeper/API Parser emit `APPLY_CLUSTER_REORDER`, Alpha clear removal, 15 `generationId: null` placeholder replacement, reorder command infrastructure | +371 / −9 (380) |
| PR-D (#9) | `54ea177` | Mock `delete`/write-order extensions, Compiler committed-generation read, end-to-end regression, manifest-last/retention/read-back assertions | +329 / −18 (347) |
| PR-E1 (#10) | `af60bb7` | Depart_Now/Return_to_Base command-adapter conversion, Publisher collision-check against retention history, genId preservation on failure, committed-state reader gate, zero-duration leg rejection | +310 / −76 (386) |
| PR-E1 Fix 6 (#11/#12) | `452d515` | Verify-gap closure: 320-line harness expansion for ownership, reorder timing, rollback, no-partial-activation, full end-to-end; 4 Publisher micro-fixes; verify-report + apply-progress updates | +572 / −80 (652) |

**Code/test-only totals (excluding docs/apply/verify):** 6 PRs, ~2,300 lines changed across 14 source files plus harness.

## Spec Merge

| Domain | Action | Details |
|--------|--------|---------|
| `itinerary` | Modified §7 (PUB-7) | Expanded to mandate committed-state discovery; Generation Publisher SHALL validate and publish complete, versioned generations. |
| `itinerary` | Modified §8 (OWN-8) | Added `TDS_Events.<generation>.json` to RULE-8A; expanded Override Handler ownership; documented ephemeral-global migration path. |
| `itinerary` | Added §20 | 10 new atomic-publication requirements with 30 scenarios: Generation ID Format, Lifecycle States, Manifest Schema, Versioned File Naming, Manifest-Last Publication Order, Committed Generation Discovery, Generation ID Propagation, RULE-8A Remediation, Generation Retention, Legacy Master Migration. |

## Out-of-Scope Findings (Pre-existing AGENTS.md WARNINGs)

Three hard-rule violations from `AGENTS.md` were identified in the initial verify report, confirmed as pre-existing and out of Phase 2 scope. Each requires a dedicated follow-up change.

| ID | Title | Evidence | Recommended Fix |
|----|-------|----------|-----------------|
| PREEXIST-1 | Occurrence IDs use `split("_")[0]` instead of `lastIndexOf("_")` | `Appender.js:90`, `Override_Injector.js:100`, `Sandbox_Engine.js:995` | Replace with `id.lastIndexOf("_")` per §2 (ID-2). |
| PREEXIST-2 | Event-ID membership uses substring matching instead of exact-key maps | `Appender.js:58-60` uses `indexOf(eventId)` for override removal | Replace with exact-key `delete` on `eventOverrides` map per §10 (OVR-10). |
| PREEXIST-3 | `TDS_Overrides.json` has writers outside Override Handler | `Alpha.js:430`, `Appender.js:133`, `Compiler.js:463`, `Finaliser.js:127`, `Override_Injector.js:142`, `Stop_Logger.js:43` | Route all to Override Handler via commands per §8 (OWN-8) and §9 (CMD-9). |

## Task Completion

All 13 task sections in the archived `tasks.md` are marked `[x]`. No implementation tasks remain unchecked. The task ledger uses sections 1–10 and 18–20; IDs 11–17 and 21 were never created (noted in initial verify as structural inconsistency, confirmed as intentional task renumbering rather than gaps).

## Skills Used

- `sdd-propose` — Phase 2 proposal
- `sdd-spec` — delta spec authoring
- `sdd-design` — technical design
- `sdd-tasks` — task breakdown
- `sdd-apply` — implementation (6 PRs)
- `sdd-verify` — verification (2 rounds)
- `sdd-archive` — final archiving (this report)

## Memory-Worthy Discoveries

- **Two-commit Finaliser/Compiler flow.** The initial implementation created two committed generations per planning flow (Finaliser commits events, then Compiler commits again), violating PUB-7's indivisible-generation contract. Fixed in PR-E1 by routing all staging through a single Publisher call.
- **`building` manifest data readable.** All resolver copies (TDS_Helper, Compiler, Dispatcher, Dashboard, Sandbox) initially accepted any active generation without checking `state === "committed"`. The fix required a committed-state gate before any reader uses active data.
- **Retention history is not ID collision scope.** The initial collision check only scanned active/previous manifest entries, not the `generationHistory` array or file paths of retained generations. Fixed by expanding the collision set to all six generations (active + prior + 4 retained).
- **Failed-candidate identity loss.** `genId` was block-scoped inside the `try` block in `Generation_Publisher.js`, so the `catch` path wrote `generationId: null`. Fixed by hoisting the minted ID and binding it to the failed manifest.
- **Manual action command adapter conversion.** `Depart_Now.js` and `Return_to_Base.js` were converted from direct `Itin_Master.json` writers to command-emitting adapters in PR-E1, closing a significant RULE-8A gap.
- **Zero-duration validation gap.** The Publisher initially only checked that three arrays existed, not that route durations were positive. A runtime probe committed `durationSecs: 0`. Fixed by adding validation gates for all required leg fields.

## Next Phase

**Phase 3 — TDS_Trip_State.json Migration** is the natural successor. The four `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` globals were explicitly deferred to Phase 3 in the MODIFIED OWN-8 spec and remain the primary backlog. Phase 3 should also close the three pre-existing AGENTS.md violations (PREEXIST-1/2/3) and centralise the duplicated manifest-resolution logic into a single shared Tasker action.

## Verdict

Phase 2 atomic publication is complete. The 6-PR chain delivered a Generation Publisher, manifest-last atomic commit, committed-state reader gates, RULE-8A writer consolidation, generation ID propagation, retention/migration, and full end-to-end verification. All 9 harness tests pass, 29/30 spec scenarios are covered, 0 CRITICAL findings remain, and the canonical spec now reflects the Phase 2 delta. The architectural baseline is ready for Phase 3's trip-state migration.
