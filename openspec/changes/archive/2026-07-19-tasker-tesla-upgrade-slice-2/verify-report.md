# Verify Report: tasker-tesla-upgrade-slice-2 (post-Patch G)

## Summary

Patch G closes both remaining code CRITICALs: every planned Sandbox row now passes through `enqueuePlannedRow`, and the defensive `EVT-DEPARTURE_POLICY_FALLBACK_USED` emission now carries the required leg ID and `details.block_step19: null`. The strengthened AC-6 harness directly verifies the configured `homeCoords` and rejects any stale-away coordinate leak. All seven harness commands pass. Task 11 remains deferred to a native Tasker device, and three earlier apply-progress chore commits omit spec IDs, so the slice verdict is **PASS WITH WARNINGS**.

## Completeness

| Dimension | Result | Evidence |
|---|---|---|
| Tasks | 10/11 complete | Task 11 (native Tasker device checks) is the remaining deferred item. |
| Harness | 7/7 commands pass | Every requested Node harness command exited `0`; exact output and SHA-256 evidence are recorded below. |
| Source inspection | PASS | All planned EVENT, RECOVERY, EOD_RETURN, and PITSTOP emitters use `enqueuePlannedRow`; the only direct `queue.push(...)` is inside the helper, apart from the non-planned `FORCED_DRIVE` control command. |
| Build/type-check/coverage | Not available | This Tasker project defines no build, type-check, lint, or coverage command. |
| Strict TDD | Inactive | `openspec/config.yaml` sets `tdd: false`, `strict_tdd: false`, and runner `none`. |

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | PASS | `test_compiler_ac1.js` passes: ASAP departs at `hardFloor`, JIT departs at `Math.max(hardFloor, depTarget)`, and both published legs retain the explicit policy. |
| AC-2 | PASS | Compiler assigns attached-leg `departurePolicy: "ASAP"` before HOLD storage; Patch G does not touch this path, and the prior supplemental HOLD probe passed. |
| AC-3 | PASS (unchanged) | Overnight/EOD behavior remains intact; every EOD_RETURN emitter now uses the helper with explicit ASAP policy in column 19. |
| AC-4 | PASS (unchanged) | Patch G does not alter empty-day synthetic-return suppression. |
| AC-5 | UNKNOWN (out of scope, 0E) | Post-return future-trip isolation remains deferred to slice 3. |
| AC-6 | PASS | The strengthened test directly asserts the EOD_RETURN destination equals `homeCoords`, the head EVENT destination equals the event coordinates, and stale-away `virtual_loc` leaks into no queue row. |
| AC-7 | PASS (unchanged) | Patch G changes row serialization only; the established day-boundary queue termination/flush behavior is unchanged. |
| AC-8 | PASS (unchanged, re-tested) | `test_compiler_ac8.js` passes with route duration `1800` and a one-time `900s` stop gap. |
| AC-9 | PASS (unchanged, re-tested) | `test_dispatcher_ac9.js` selects the future actionable leg over an overdue leg and uses the 30-minute sync bucket. |
| AC-10 | PASS (unchanged, re-tested) | Empty and truly stale masters clear action outputs, use 60-minute idle sync, and emit `IDLE_SYNC_ENGAGED`. |

## Invariants

| Invariant | Verdict | Evidence |
|---|---|---|
| MODIFIED INV-0.1 | PASS | All planned EVENT, RECOVERY, EOD_RETURN, and PITSTOP emitters use `enqueuePlannedRow`; the helper pads to 18 fields and appends explicit ASAP/JIT as column 19, while the head policy is mirrored to `block_step19`. |
| MODIFIED INV-0.3 | PASS | Live base rebinds `state.loc` to `getBase(state.time).coords`; the AC-6 harness directly verifies home anchoring and rejects stale-away leakage. |
| MODIFIED INV-0.6 (slice 1) | PASS (unchanged) | Future-over-overdue, overdue-within-window, and truly stale/idle runtime scenarios all pass. |
| MODIFIED INV-0.8 (slice 1) | PASS (unchanged) | The AC-8 harness proves route-only duration and exactly one stop-padding gap. |

## Event codes

| Code | Verdict | Evidence |
|---|---|---|
| EVT-LIVE_BASE_OVERRIDES_LEGACY_ORIGIN | PASS | Sandbox emits the required structured warning, and both AC-6 fixtures observe it. |
| EVT-DEPARTURE_POLICY_FALLBACK_USED | PASS (dead code) | The emission has `component: "Sandbox"`, `tripId: fields[9] || null`, and `details.block_step19: null`; in normal operation it is never fired because every caller passes an explicit policy. |
| EVT-STALE_TRIP_REJECTED (slice 1) | PASS (unchanged) | `test_dispatcher_relevance.js` observes the event for a truly stale leg. |
| EVT-IDLE_SYNC_ENGAGED (slice 1) | PASS (unchanged) | Empty-master and truly-stale harnesses observe the event with 60-minute idle sync. |

## Implementation cross-check

| Check | Result | Evidence |
|---|---|---|
| Helper row width and policy position | PASS | `while (fields.length < 18) fields.push("")` followed by `fields.push(effectivePolicy)` produces exactly 19 fields for every current 15- or 16-field planned row; policy is column 19. |
| Four planned row formats use the helper | PASS | EVENT, RECOVERY, EOD_RETURN, and PITSTOP/`stopType` paths all call `enqueuePlannedRow`; no raw planned-row `queue.push(...)` remains. |
| Non-planned direct queue command | PASS / not applicable | `queue.push("FORCED_DRIVE|" + evId)` is a control command, not a planned travel row. |
| `state.loc` pass-start rebind | PASS | With stale itinerary plus reliable live base and no active trip, Sandbox binds `state.loc` to current base coordinates before planning. |
| `state.isStableOrigin` first-leg handling | PASS | Patch G resets the flag to `false` immediately after the first EVENT leg is emitted. |
| Fallback payload | PASS | The defensive branch includes a row-derived trip ID, `block_step19: null`, row type, and reconstructed ASAP policy. |

## Harness assertion review

- The stale-away fixture directly asserts the head EVENT destination is `eventCoords`.
- It scans every emitted row and fails if column 3 contains `awayCoords`.
- It finds the EOD_RETURN row and directly asserts its destination is the configured `homeCoords`.
- It still proves the stale-away and home-control queues are identical, the head policy is JIT, `block_step19` is JIT, and all generated rows end in ASAP/JIT.

## Runtime evidence

Seven-test combined output SHA-256 (commands in the order shown below): `3fb0ec25d61c1fe8de91da8466eed52846204988c9eab43329479b5ffcb0469c`.

### `node harness/test_compiler_ac1.js`

Exit `0`; output SHA-256 `2c8f81b57be73aab402f6ba9879e17f9c24becb5acc219abff20f8f1f9aa9f7e`.

```text
PASS: AC-1 Compiler: explicit departurePolicy consumed; isPrevBase reconstruction removed
  ASAP departUnix = 1700000000 (hardFloor = 1700000000)
  JIT  departUnix = 1700001500 (max = 1700001500, depTarget = 1700001500)
  no DEPARTURE_POLICY_FALLBACK_USED flash in either sub-test
```

### `node harness/test_compiler_ac8.js`

Exit `0`; output SHA-256 `72dfc67a42a67d8e90df23f687e84b5374dd500e1104e67bf899df1daa56689c`.

```text
PASS: AC-8 Compiler: stop padding applied once (5,10 = 15 min, not 30)
  leg1.durationSecs = 1800
  leg1.arriveUnix   = 1700001800
  leg2.departUnix   = 1700002700
  gap               = 900s
```

### `node harness/test_dispatcher_ac9.js`

Exit `0`; output SHA-256 `7cfa48a30794f837f8ccecf44868ad63a70c11c3f2b5fc44a7a83692434f74a7`.

```text
PASS: AC-9 Dispatcher: overdue within window ranks below future; future leg selected; 30-min bucket
  selectedTime   = 1700003600 (future=1700003600)
  Next_Sync      = 22.43 (30-min bucket, not 3)
  STALE flash    = no (expected: past leg is within relevance window)
```

### `node harness/test_dispatcher_ac10.js`

Exit `0`; output SHA-256 `0118c07fb8f1f6a75a8c2d69090252547f8652eb65208f7dd3a3250a58111cdb`.

```text
PASS: AC-10 Dispatcher: empty master → idle sync at 60 min, IDLE_SYNC_ENGAGED
  Next_Sync   = 23.13 (expected 23.13 = +60 min)
  IDLE flash  = yes
```

### `node harness/test_dispatcher_relevance.js`

Exit `0`; output SHA-256 `640862f40c81a9ff89f941864120101a4f8b43a49aa472c9e388e8a4f886b5ed`.

```text
PASS: Dispatcher relevance: truly stale leg rejected; idle sync at 60 min, IDLE_SYNC_ENGAGED
  itin_mode1  = NONE
  itin_time1  = 0
  Next_Sync   = 23.13 (expected 23.13 = +60 min)
  STALE flash = yes
  IDLE flash  = yes
```

### `node harness/test_dispatcher_overdue_wins.js`

Exit `0`; output SHA-256 `dddac6e39b36efbbbfef05515cba5cb46c3b79c592be3a3d9d1dbf15f6bac64f`.

```text
PASS: Dispatcher relevance: overdue-within-window selected when no future leg; sync = 10 min
  selectedTime = 1699996400
  Next_Sync    = 22.23 (10-min bucket, not idle)
```

### `node harness/test_sandbox_ac6.js`

Exit `0`; output SHA-256 `a61f26d5f5abf54702d8f6380c31fa641ee9d41ce95b5c9ad195fbef46de469c`.

```text
PASS: AC-6 Sandbox: stale-away itinerary loses to live base; future trip JIT
  control: head policy = JIT
  stale-away: queue identical to control (origin rebound to home), head policy = JIT
  block_step19 = JIT
  all 2 stale-away queue rows carry an explicit ASAP/JIT policy
```

Build command: unavailable; no build was executed and no build output hash exists.

## Commit hygiene

| Commit | Subject | Conventional? | Cites spec IDs? |
|---|---|---|---|
| `59b89e9` (Patch D) | `feat(sandbox): explicit departurePolicy + live origin (AC-1 emit, AC-6)` | yes | yes — MODIFIED INV-0.1, MODIFIED INV-0.3, AC-1, AC-6 |
| `d73c8ba` (D progress) | `chore(tasker-tesla-upgrade-slice-2): apply-progress for Patch D` | yes | no |
| `1fd1dd9` (Patch E) | `fix(compiler): consume explicit departurePolicy; remove isPrevBase reconstruction (AC-1)` | yes | yes — MODIFIED INV-0.1, AC-1, EVT-DEPARTURE_POLICY_FALLBACK_USED |
| `b388c5f` (E progress) | `chore(tasker-tesla-upgrade-slice-2): apply-progress for Patch E` | yes | no |
| `835aead` (Patch F) | `fix(sandbox+compiler): close slice-2 verify CRITICALs (state.loc, queue columns, HOLD order, fallback event)` | yes | yes — MODIFIED INV-0.1, MODIFIED INV-0.3, AC-1, AC-2, AC-6, EVT-DEPARTURE_POLICY_FALLBACK_USED |
| `bf15340` (F progress) | `chore(tasker-tesla-upgrade-slice-2): apply-progress for Patch F` | yes | no |
| `7ee05af` (Patch G) | `fix(sandbox): route all queue emitters through enqueuePlannedRow; complete slice-2 CRITICALs` | yes | yes — MODIFIED INV-0.1, MODIFIED INV-0.3, AC-6, EVT-DEPARTURE_POLICY_FALLBACK_USED |
| `73ec4f2` (G progress) | `chore(tasker-tesla-upgrade-slice-2): apply-progress for Patch G` | yes | yes — INV-0.1, AC-6, EVT-DEPARTURE_POLICY_FALLBACK_USED |

## CRITICAL / WARNING history

- **CLOSED:** AC-6/INV-0.3 `state.loc` rebind (was flagged; closed by Patch F).
- **CLOSED:** INV-0.1 four queue emitters omitting column 19 (was flagged; closed by Patch F's helper).
- **CLOSED:** AC-2 HOLD-order regression (was flagged; closed by Patch F).
- **CLOSED:** `EVT-DEPARTURE_POLICY_FALLBACK_USED` component mismatch (was flagged; closed by Patch F).
- **CLOSED:** INV-0.1 queue contract incomplete (was flagged; closed by Patch G).
- **CLOSED:** `EVT-DEPARTURE_POLICY_FALLBACK_USED` payload incomplete (was flagged; closed by Patch G).
- **CLOSED:** AC-6 indirect evidence (was flagged; strengthened by Patch G).
- **WARNING:** Task 11 native Tasker device checks remain deferred and require user sign-off.
- **WARNING:** The Patch D, E, and F apply-progress chore commits are conventional but do not cite spec IDs; the Patch G progress commit corrects this practice.

No code CRITICAL remains in the requested slice-2 re-verification scope.

## Suggestions

- Add a focused helper-level test for the defensive fallback payload if `enqueuePlannedRow` is later made testable independently; all production callers currently make the branch unreachable.
- Promote the supplemental attached-HOLD probe into a committed AC-2 harness.
- During Task 11, explicitly verify the native Tasker splitter exposes column 19 as `block_step19` before production reliance.
- Preserve spec-ID citations in all future apply-progress chore commits, following Patch G's example.

## Out of scope (deferred)

- AC-5 (sub-item 0E).
- ID parsing migration.
- Single-writer consolidation.
- DST-safe day boundaries.
- `TDS_Trip_State.json` migration.
- Full `originSource` enum.
- `TDS_Run_Manifest.json` (Phase 2).

## Verdict

**SLICE 2: PASS WITH WARNINGS** — all requested code CRITICALs are closed and all seven harness commands pass; only native Tasker sign-off and commit-documentation hygiene remain as warnings.
