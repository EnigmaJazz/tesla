# Proposal: tasker-tesla-phase0-followups

Complete Phase 0 acceptance: day-boundary correctness, post-return isolation, fallback order, and exact-key override reads

## Context / Problem

Phase 0 retains eight evidence-backed exclusions: AC-3, AC-5, AC-7, 0B, 0E, INV-0.4, INV-0.7, and Sandbox OVR-10 cleanup. These violate canonical itinerary invariants around local-day isolation, lifecycle completion, route metrics, and exact identity handling.

Phases 1–6 roadmap work is explicitly out of scope.

## Requirements / Intent

1. Same-location overnight creates today's explicit EOD return and tomorrow's base/JIT head leg, without `_IN` suffix inference (AC-3).
2. Each leg receives timezone-derived `planningDay`; day arithmetic is DST-safe (0B).
3. Queue flush and pending-chain propagation terminate at the local planning-day boundary (AC-7).
4. Manual-return completion flows through `COMPLETE_TRIP`; it never promotes a later-day trip, which remains `PLANNED`/`JIT` (AC-5, 0E, TRIP-4).
5. Unplanned movement does not synthesize a return; suppression is logged (INV-0.4).
6. Route duration fallback is: validated API → Sandbox metrics → supported local active-travel estimate → reject/log; zero-duration travel never publishes (INV-0.7, CACHE-11).
7. Sandbox override and preference reads use exact-key maps only; remove substring membership checks and replace `evId.split("_")[0]` with last-underscore occurrence parsing (OVR-10).

## Success Criteria

- [ ] Structured JSON emits `EVT-OVERNIGHT_BOUNDARY_CREATED`, `EVT-CROSS_DAY_CHAIN_REJECTED`, `EVT-FUTURE_TRIP_NOT_DUE`, `EVT-SYNTHETIC_RETURN_SUPPRESSED`, and, where fallback occurs, `EVT-DEPARTURE_POLICY_FALLBACK_USED`.
- [ ] Harness coverage proves each affected acceptance criterion, including DST and exact-key decoys.
- [ ] Full harness is 20/20 green. (Proposal-time baseline was 17/17; the design predicted the harness growing from 17 to 20 scripts — see design.md "Full harness grows from 17 to 20 scripts and must remain green.")

## Approach

One change, delivered as four slices across three PRs: A—day boundaries (AC-3/AC-7/0B); B—post-return isolation and synthetic-return suppression (AC-5/0E/INV-0.4); C—duration fallback (INV-0.7); D—OVR-10 exact-key cleanup. A, B, and C+D map to PRs 1–3; B and D never share a PR.

This remains one change because it shares the itinerary spec surface and requires one verification/archive record. PR separation preserves the 400-line review budget and isolates behavioral risk.

## Risks

| Risk | Mitigation |
|---|---|
| "10" versus ~17 Sandbox membership sites | Scope all discovered sites, not a fixed count. |
| AC-3 change regresses AC-6 live-base precedence | Add same-slice regression coverage. |
| Flush semantics change | Re-verify `test_departure_day.js` assertions. |
| `planningDay` collides with existing day validation | Keep it Sandbox-local and DST-compatible. |
| Port dependency | Resolved: exact-key reader is on merged master. |

## Rollback Plan

Each slice is independently revertible. Revert Slice A or B commits and restore their prior harness fixtures if EOD/flush or return lifecycle behavior regresses. No schema migration is involved: overrides/preferences remain schema-v2. Slice D is read-path-only cleanup.
