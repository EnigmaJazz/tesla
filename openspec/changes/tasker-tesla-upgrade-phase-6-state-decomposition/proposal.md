# Proposal: Phase 6 — State Decomposition (transient globals → trip/reducer state)

## Intent

Complete the Phase 3 migration contract (4 memory keys state-only; 5 globals state-backed). Write side ~80% migrated; reads consume globals; `project()` no-op (:342); 3 commands missing; prune gap; vestigial paths. Canonical spec lacks the contract (line 98: memories "pending Phase 3 migration") — spec phase MUST sync.

## Scope

**In**: reducer gaps + projection; memory read cutover + OBSERVE_DEPARTURE caller; vestigial deletion; config/testing refresh; harness inversion (E2-1..4).
**Out (non-goals)**: resolver copies (keep + amend spec); device-only Tasker flows; Alpha untouched; 18-file boundary.

## Capabilities

**New**: None.
**Modified**: `itinerary`
- ADD migration contract (4 keys state-only; 5 globals state-backed; globals MAY project) + resolver requirement from Phase 3 delta.
- MODIFY line-98 stale text; line-24/154 reads → state projection; resolver-copies requirement (Tasker isolation).
- REMOVE: none. Verify line-661 Action_Lock coherence after merge deletion.

## Approach

Approach 2: state-authoritative reads; 5 globals as `project()`-written caches (spec-permitted); 4 memory globals retired. Rejected: full cutover (blast radius); minimal cleanup (unsatisfied). 3 chained slices (≤400 Δ lines each; tests count):

| Slice | Work (files) | ~Δ lines |
|---|---|---|
| 1 | `project()`; base-leave/lateness-halt/status commands; table + tests | 300–380 |
| 2 | read cutover (Compiler, Finaliser, Sandbox, Stop_Logger, Override_Handler) + harness inversion (E2-1..4, ac5, departure_day, trip_lifecycle) | 380–460 → split 2a/2b if over |
| 3 | vestigial deletion (Finaliser merge, Optimize_Queue, Count, readOrigin; Alpha.js) + config/testing docs | 150–200 |

## Risks & Rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Departure-diff semantics | Med | Dispatcher stages; keep departDiffMins; day-boundary test |
| Sandbox snapshot reads | Med | Preserve module-top snapshot |
| Slice 2 over budget | Med | Split 2a/2b; independent, revertible |
| Projection discipline | Low | Gated by commit + read-back |
| Spec drift if sync skipped | Med | Spec phase MUST ADD contract |

**Rollback**: per-slice revert; `project()` keeps writing globals, consumers never regress; keep memory writers until slice 2 verified; no destructive schema change.

## SchemaVersion decision

NO bump — fields exist in v1 `initialState`; commands activate dead fields. Any future 1→2 MUST ship a migrator; current unknown-version reset (:94–97) is data loss.

## Proposal question round

1. OBSERVE_DEPARTURE staging: Dispatcher vs planner? 2. Resolver copies: amend spec (default) vs cached-global indirection? 3. No external task reads the 4 memory globals? 4. No schema bump?

## Dependencies

None external; 28/28 harness baseline is the gate.

## Success Criteria

- 28/28 harness green
- No live get/set of the 4 memory globals
- `project()` writes 5 globals post-commit, read-back verified
- Canonical spec carries the migration contract
- E2-1..E2-4 assert state reads, not writes
