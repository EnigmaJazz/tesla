# Archive Report: tasker-tesla-upgrade (first slice)

**Date:** 2026-07-19
**Status:** PASS WITH WARNINGS
**Change:** tasker-tesla-upgrade — Phase 0 first slice: stop-padding, stale-departure containment, idle sync

## Verdict

The verify-report at `verify-report.md` concludes **PASS WITH WARNINGS**. No CRITICAL issues. All scoped acceptance criteria (AC-8, AC-9, AC-10), modified invariants (INV-0.6, INV-0.8), and required event codes (EVT-STALE_TRIP_REJECTED, EVT-IDLE_SYNC_ENGAGED) pass via five deterministic harness tests.

## Commits

| Hash | Subject |
|------|---------|
| `99229c8` | `fix(compiler): route-only durationSecs; stop padding once (AC-8)` |
| `22e69a4` | `fix(dispatcher): skip stale departures; idle sync at 60 min (AC-9, AC-10)` |
| `1f20971` | `fix(dispatcher): correct targetDrive property name; tighten AC-9 test` |
| `33e070f` | `fix(dispatcher): full per-leg relevance deadlines; rank past-within-window below future (INV-0.6)` |

## Merge: Delta Specs → Canonical

| Domain | Action | Details |
|--------|--------|---------|
| `itinerary` | Updated §0 INV-0.6 | Expanded with slice-specific stale/overdue/negative-gap rules |
| `itinerary` | Updated §0 INV-0.8 | Expanded with `durationSecs` route-only clarification |
| `itinerary` | Updated §16 AC-8/9/10 | Added Given/When/Then detail rows to acceptance criteria |
| `itinerary` | Updated §17 | Added `EVT-IDLE_SYNC_ENGAGED` to required event codes |
| `itinerary` | Added header note | First-slice status marker linking to archive audit trail |

Constants `RELEVANCE_DEFAULT_SECS`, `RELEVANCE_RECOVERY_SECS`, `RELEVANCE_EOD_SECS`, `RELEVANCE_DROPIN_GRACE_SECS`, `IDLE_SYNC_MINS`, `SOON_SYNC_MINS`, and `ACTIONABLE_LOOKAHEAD_SECS` were **not** added to the canonical spec — these are implementation details. The delta event spec for `STALE_DEPARTURE_REJECTED` was also omitted because the implementation uses the canonical `STALE_TRIP_REJECTED` (already listed in §17).

## Warnings (carried forward)

1. **gentle-ai lifecycle receipt not bound.** The gentle-ai review system could not bind a terminal receipt for Patch A, Patch B, or Patch C due to workspace projection inflation and CWD-mismatch issues documented in `apply-progress.md`. Manual readability review (Patch A) and manual reliability review (Patch B) stand in as the canonical review evidence.

2. **Real-device Tasker scenarios pending.** Task 7 (`tasks.md:30-33` — run design §5's manual scenarios on an Android device) remains unchecked. The deterministic harness tests cover the scoped behaviour, but end-to-end Tasker execution has not occurred.

3. **EOD 24h fallback is a stand-in.** `relevanceDeadlineForLeg()` at `Dispatcher.js:50-52` returns `nowSec + RELEVANCE_EOD_SECS` (24-hour rolling window) for EOD returns rather than a deadline anchored to the leg or local end-of-day. This needs a dedicated boundary test in the broader §6/day-boundary slice.

## Stale-Task Reconciliation

Three unchecked tasks in the archived `tasks.md`:
- **Task 3** (bind gentle-ai receipt for Patch A): Superseded by manual review; documented in `apply-progress.md`.
- **Task 6** (bind gentle-ai receipt for Patch B): Same — manual review stands in.
- **Task 7** (real-device scenarios): Outstanding; requires the user's Android device.

These are **not** implementation-task stale checkboxes. The apply-progress record and verify-report prove all implementation work (Patches A, B, B', C) is complete. Archive proceeds per the orchestrator's explicit first-slice intent.

## Harness Test Evidence (all exit 0)

| Test | Result |
|------|--------|
| `node harness/test_compiler_ac8.js` | PASS — stop padding applied once (5,10 = 15 min, not 30) |
| `node harness/test_dispatcher_ac9.js` | PASS — overdue within window ranks below future; future leg selected; 30-min bucket |
| `node harness/test_dispatcher_ac10.js` | PASS — empty master → idle sync at 60 min, IDLE_SYNC_ENGAGED |
| `node harness/test_dispatcher_relevance.js` | PASS — truly stale leg rejected; idle sync at 60 min, IDLE_SYNC_ENGAGED |
| `node harness/test_dispatcher_overdue_wins.js` | PASS — overdue-within-window selected when no future leg; sync = 10 min |

## Next-Slice Recommendation

**`tasker-tesla-upgrade-slice-2`** should address:
- AC-1 (explicit departure policy propagation)
- AC-5 (post-return future-trip isolation)
- AC-6 (stale-away itinerary vs live base)
- DST-safe day-boundary comparisons and exact local-end-of-day relevance
- ID parsing migration (`lastIndexOf` instead of `split[0]`)
- Single-writer consolidation for `TDS_Overrides.json`
- Structured logging persistence (beyond `flash()`)
- EOD deadline test with anchored rather than rolling fallback
