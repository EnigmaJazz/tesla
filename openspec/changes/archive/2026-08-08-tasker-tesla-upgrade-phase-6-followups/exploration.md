# Exploration: Phase 6 Follow-ups — Batch Staging Mechanism & Non-Base-Origin Departure Observation

**Change:** `tasker-tesla-upgrade-phase-6-followups`
**Date:** 2026-08-07
**Artifact store:** openspec

---

## Executive Verdict (read this first)

- **Follow-up 1 (batch staging) is a REAL production gap, not hygiene.** In the documented serial
  Tasker model — and per the code's own comments and adapter conventions — only the **last** staged
  command per pass reaches the reducer. The Sandbox stages up to four reducer observations per pass
  (base arrival/leave, `COMPLETE_TRIP`, `OBSERVE_STATUS`, `OBSERVE_LATENESS_HALT`) with no
  primary-last discipline, so every observation except the final `OBSERVE_LATENESS_HALT` is silently
  dropped on device. The harness masks the loss because its `reducer()` shim applies each staging
  synchronously. **User-visible consequence:** `userAtBase`, `currentStatus`, `departures[]`, and the
  base-arrival `COMPLETE_TRIP`/manual-return completion never reach trip state in production.
- **Follow-up 2 (non-base-origin departure observation) is a real but LOW-stakes gap, and its
  stated trigger condition is not met.** The `AUTO_REPLAN` API-conflict signal (`apiConflictStr`,
  Compiler.js:603-611) is computed from live lateness (`liveLateMins`), **independent of departure
  records** — so it does NOT weaken for non-base trips. What weakens is the cross-day
  `departChanged`/`departDiffMins` drift signal, a diagnostic. The fix is cheap and natural (edge
  detection at the active-leg window the Sandbox already computes), but it is **moot until FU1
  lands**, because in the documented production model `OBSERVE_DEPARTURE` is already dropped for ALL
  trips (last-wins clobbering), not just non-base ones.

---

## Current State (verified from code, with anchors)

### The serial command-delivery model is last-wins

1. **`stageReducerCommand(name, payload)`** (Sandbox_Engine.js:432-438):
   ```js
   function stageReducerCommand(name, payload) {
       setLocal('par1', name);
       setLocal('par2', JSON.stringify(payload));
       if (typeof reducer === 'function') { reducer(name, payload); }
   }
   ```
   - In the **harness**, `reducer` IS a function (mock_tasker.js:94-103) → every staging applies
     synchronously → the harness sees ALL commands committed.
   - In **production Tasker**, `reducer` is undefined (Tasker JSlet standalone isolation — no
     cross-script function calls; this is the documented reason for the byte-identical
     `readActiveGeneration` copies, TDS_Helper.js:20-24 / REQ-6STATE-6) → only `setLocal` runs.
     The serial task then invokes `TDS_State_Command.js` once, reading the **final** `par1`/`par2`.
2. **The code documents last-wins explicitly** (Sandbox_Engine.js:426-431):
   > "The synchronous reducer shim (harness) applies it immediately; **in the serial Tasker task the
   > last staged command reaches the reducer next.**"
3. **Adapters already engineer around last-wins** — proof the authors know the model:
   - `Depart_Now.js:27-43`: stages `OBSERVE_LATENESS_HALT` first, then `DEPART_NOW` **last**,
     with the comment: "The primary DEPART_NOW envelope is staged last so the serial chain still
     delivers the departure command." (The halt observation is sacrificed.)
   - `Return_to_Base.js:83-115`: stages `OBSERVE_STATUS`, then `OBSERVE_LATENESS_HALT`, then
     `RETURN_TO_BASE` **last** — same comment pattern. Both earlier observations are sacrificed.
   - `Finaliser.js:242-293` (mid-chain rule): the release chain goes into dedicated
     `tds_release_par1/par2` locals precisely because "the staged par1 MUST stay the publish
     candidate" — par1/par2 is a single slot.
4. **TDS_State_Command.js routes exactly one command per invocation** (:443-456): reads
   `local("par1")`/`local("par2")` once, validates, routes to exactly one owner. There is **no
   loop, no reducer-command queue, and no batch path**. The only queue in the system is
   `TDS_Reorder_Commands.json` (append via `ENQUEUE_REORDER` :176-190; drained/cleared by the
   Generation Publisher — reorder commands only, not reducer observations).
5. **Harness 28/28 is green while production drops commands** — confirmed by re-running the suite
   (28/28 PASS). `test_ac5.js:312-318` ("Sandbox base arrival must drive a reducer state write …"
   asserts `lifecycleState === 'COMPLETED'`) passes ONLY because the shim applies `COMPLETE_TRIP`
   synchronously mid-pass.

### Sandbox staging order per pass (the loss)

One Sandbox pass (`idx` invocation) stages, in order:

| # | Site | Command | When |
|---|------|---------|------|
| 1 | :538 | `OBSERVE_LIVE_BASE` | Updating + coords, `currentlyAtBase && !prevAtBase` |
| 2 | :565-573 | `COMPLETE_TRIP` (× N manual trips) | same branch |
| 3 | :580 | `OBSERVE_BASE_LEAVE` | `!currentlyAtBase && prevAtBase` (mutually exclusive with 1-2) |
| 4 | :585 | `OBSERVE_DEPARTURE` | same branch (tripId from `oldItin[0].targetEventId`) |
| 5 | :634 | `OBSERVE_STATUS` | ALWAYS (Updating + coords) |
| 6 | :897 | `OBSERVE_LATENESS_HALT {halt:false}` | ALWAYS (per-pass reset) |
| 7 | :1279/:1373/:1449/:1670 | `OBSERVE_LATENESS_HALT {halt:true}` | on lateness halt in row loop (after 6) |

In production only the **last executed** of these reaches the reducer. For a base-arrival pass that
is `OBSERVE_LATENESS_HALT` — so `OBSERVE_LIVE_BASE`, `COMPLETE_TRIP`, and `OBSERVE_STATUS` are all
lost. For a base-leave pass, `OBSERVE_BASE_LEAVE` and `OBSERVE_DEPARTURE` are lost. Consequences:

- `userAtBase` never becomes `true` in state → `project()` never flips the `User_At_Base` global →
  the base-arrival edge never latches on device (Phase 6 REQ-6STATE-2/3 dead in production).
- Base-arrival `COMPLETE_TRIP` never fires → manual returns never complete via the Sandbox path and
  the action session never closes downstream (the Finaliser release chain still covers completion,
  but only via its own separate slot — the Sandbox observation path is inert).
- `OBSERVE_STATUS` is always staged before the always-run halt reset (:634 then :897) → `currentStatus`
  never updates from the Sandbox in production.
- `OBSERVE_DEPARTURE` never lands → `departures[]` never populated by the Sandbox → Compiler's
  cross-day diff (Compiler.js:567-572) has no record for ANY trip in production.

### FU2: non-base-origin departure observation

- The **only** production caller of `OBSERVE_DEPARTURE` is the Sandbox base-leave branch
  (Sandbox_Engine.js:574-591), gated on `!currentlyAtBase && prevAtBase` — a **transition out of
  base**. A JIT trip starting from a non-base origin (vehicle already away) has
  `currentlyAtBase=false, prevAtBase=false` → neither the arrival nor the leave branch fires →
  no `OBSERVE_DEPARTURE`. (D1 in the Phase 6 design.md:11 rejected Dispatcher/Compiler callers.)
- **Fallback in Compiler** (Compiler.js:567-572): `stateTrips[leg.targetEventId].departures[]` —
  if empty, `oldD` stays `null` → `departChanged` stays `"false"` and `departDiffMins` stays `0`
  (:580-594). If a prior-day record exists (from an earlier base-origin departure), the diff
  compares against that older record — the "falls back to the prior-day record" behavior the
  archive described.
- **The API-conflict signal does NOT depend on departure records**: `apiConflictStr =
  "AUTO_REPLAN|" + targetEventId` (Compiler.js:603-611) fires when `liveLateMins > 0` (API-provided
  engine lateness) and the event is not ignored and is a real `EVENT` not `ACTIVE_TRAVEL`. No
  departure-record input. So the FU2 trigger condition ("follow-up if the API-conflict signal
  weakens") is **not met** — `AUTO_REPLAN` is unaffected for non-base trips.
- **Observable signal exists**: the Sandbox already detects an active leg's departure window at
  :612-632 (`leaveSec > 0 && nowSec >= leaveSec - 600 && nowSec <= latestValidDepart` →
  `resolvedStatus` becomes Driving/Walking/etc.), with the trip identity available as
  `oldItin[0].targetEventId`. A non-base departure is observable there as the head leg entering its
  window while `!currentlyAtBase` — provided edge detection (see Approaches) prevents per-pass spam
  (the reducer dedupes only on identical `at`, Trip_State_Reducer.js:424-427).

---

## Affected Areas

- `Sandbox_Engine.js` — `stageReducerCommand` (:432-438) and all staging sites (:538, :565-573,
  :580, :585, :634, :897, :1279, :1373, :1449, :1670); ordering discipline or batch accumulation.
- `TDS_State_Command.js` — new batch command in `REDUCER_COMMANDS` (:39-42) +
  `REDUCER_REQUIRED_FIELDS` (:57-80), or a queue-drain path; byte-exact field parity.
- `Trip_State_Reducer.js` — batch apply (loop per sub-command with validate/commit/project) if the
  batch envelope approach is chosen; already has per-command `validateFields` + `apply*` to reuse.
- `Depart_Now.js` (:31-43), `Return_to_Base.js` (:88-115) — migrate the sacrificed secondary
  observations to the batch mechanism (or keep primary-last if batch covers only the Sandbox).
- `Finaliser.js` — `COMPLETE_DROPIN`/`OBSERVE_ARRIVAL` setLocals (:143-172) are clobbered by the
  publish candidate at :224 in production; the mid-chain `tds_release_par1/par2` precedent (:268-293)
  is the in-repo pattern to generalise.
- `harness/mock_tasker.js` — add a production-faithful serial path (reducer NOT a function; capture
  staged par1/par2; then run TDS_State_Command) so the harness can prove/refute delivery.
- `harness/test_ac5.js`, `test_single_writer.js`, `test_state_command.js` — new RED test
  (production-faithful: only last command delivered today → FAIL; batch delivered after fix →
  PASS); update base-arrival assertions.
- `openspec/specs/itinerary/spec.md` — §9 CMD-9 (:100-101) batch contract; REQ-6STATE-4 (:851-858)
  caller scope for non-base departures.

---

## Approaches

### Follow-up 1 — batch staging mechanism

1. **Batch envelope command (recommended)** — `stageReducerCommand` accumulates into a local array;
   at pass end one command (e.g. `REDUCER_BATCH`) is staged with `par2 = {commands:[{command,
   payload}...]}`; TDS_State_Command routes it to the reducer (one owner); the reducer applies each
   sub-command in order with existing per-command validation/commit/projection.
   - Pros: single serial handoff preserved — no Tasker task-loop wiring change; no new file; fully
     harness-testable (production-faithful RED test: run sandbox, run TDS_State_Command once,
     assert all observations landed); ordering preserved; reducer stays sole writer.
   - Cons: new command + nested validation mirroring `REDUCER_REQUIRED_FIELDS`; variable batch size
     (COMPLETE_TRIP loop); partial-failure semantics must be defined (all-or-nothing vs
     apply-valid-and-log); touches the reducer command surface.
   - Effort: Medium.

2. **Queue file + drain loop** — `stageReducerCommand` appends `{command,payload}` to a JSON queue
   (e.g. `TDS_State_Commands.json`); TDS_State_Command pops one per invocation; the Tasker serial
   task re-invokes it until the queue drains.
   - Pros: mirrors the `TDS_Reorder_Commands.json` precedent (append + drain + clear); durable
     across pass boundaries; orders across multiple producers.
   - Cons: new single-writer resource (contract table update in AGENTS.md); Sandbox becomes a queue
     writer (ownership question); the drain loop lives in Tasker task wiring, which the harness
     cannot verify; more moving parts.
   - Effort: Medium-High.

3. **Primary-last + dedicated observation slots** — keep par1/par2 for the highest-priority command;
   stage other observations into named slots (`tds_obs1_par1/par2`, …) drained by additional
   TDS_State_Command invocations, generalising Finaliser's `tds_release_par1/par2`.
   - Pros: minimal change to existing adapter pattern; no new command surface.
   - Cons: variable N (COMPLETE_TRIP × manual trips) makes fixed slots brittle; slot naming sprawls;
     Tasker wiring must invoke the router once per slot.
   - Effort: Low-Medium (for the Sandbox; Medium-High once generalised).

### Follow-up 2 — non-base-origin departure observation

1. **Edge-triggered departure observation in the Sandbox active-leg window (recommended)** — in the
   status-resolution branch (:612-632), when the head leg enters its departure window while
   `!currentlyAtBase`, stage `OBSERVE_DEPARTURE` with `oldItin[0].targetEventId` — guarded so it
   fires once per leg (e.g. skip when the last `departures[]` record for that trip already matches
   the current planning day / window entry).
   - Pros: reuses the identity/time the Sandbox already computes; small, local, harness-testable;
   completes REQ-6STATE-4 for all departures.
   - Cons: needs careful edge detection (per-pass spam → `departures[]` pollution; reducer only
     dedupes identical `at`); must not double-observed base-leave departures; interacts with FU1
     ordering (moot until batch staging exists).
   - Effort: Low (once FU1 lands).

2. **Extend the base-leave edge to "away" transitions** — treat "head leg became active while not at
   base" as a base-leave-equivalent edge in the same branch structure.
   - Pros: keeps observation in one edge-detection site.
   - Cons: conflates base-leave and JIT-departure semantics; risks double observation when the
     vehicle later returns; more invasive to the existing branch logic.
   - Effort: Low.

3. **Defer / document (status quo)** — keep the prior-day-record fallback; revisit only if the
   cross-day drift signal becomes load-bearing.
   - Pros: zero risk; AUTO_REPLAN is unaffected (verified).
   - Cons: cross-day `departChanged`/`departDiffMins` stays silent for non-base trips; REQ-6STATE-4
     partially unfulfilled.
   - Effort: None.

---

## Recommendation

**Primary (FU1): Approach 1 — batch envelope command.** It is the only option that fixes production
delivery without touching Tasker task wiring (unverifiable from the harness), keeps the reducer as
sole writer, and enables a production-faithful RED test that proves today's loss and the fix. Migrate
`Depart_Now.js`, `Return_to_Base.js`, and Finaliser's clobbered observations (:143-172) onto the same
batch path; keep Finaliser's `tds_release_par1/par2` mid-chain rule for the publish/release sequence.

**Secondary (FU2): fold in as a small addition after FU1 lands** — edge-triggered `OBSERVE_DEPARTURE`
in the Sandbox active-leg window (Approach 1), since it is cheap and the mechanism already exists by
then. If budget is tight, FU2 is safe to defer: the archive's stated trigger ("API-conflict signal
weakens") is **not met** — `AUTO_REPLAN` is departure-record-independent (Compiler.js:603-611).

**Do not** fix FU2 before FU1: `OBSERVE_DEPARTURE` cannot reach the reducer in production until
batch staging exists, for base-origin or any other departure.

**Delivery note:** one change, two slices (FU1 core; FU2 optional tail). Slice forecast is Medium
for the 400-line review budget (Sandbox + State_Command + Reducer + harness RED test + 2 adapters).

---

## Risks

- **Harness divergence**: the 28/28 suite must gain a production-faithful serial test, or the gate
  keeps certifying last-wins behavior as correct. This is the single most important test to add.
- **Batch validation parity**: nested commands must mirror `REDUCER_REQUIRED_FIELDS` byte-exact,
  or invalid payloads can reach the reducer (violates REQ-4CMD-1).
- **Partial-failure semantics**: a batch with one invalid sub-command needs an explicit
  all-or-nothing vs apply-valid-and-log decision; the reducer's per-command commit/project
  discipline must be preserved.
- **Variable batch size**: the base-arrival `COMPLETE_TRIP` loop makes batch size unbounded (one
  per active manual trip); payload caps or split-flush may be needed.
- **Adapter migration**: changing the serial model touches Depart_Now/Return_to_Base/Finaliser
  staging; a partial migration would leave some observations still sacrificed.
- **FU2 edge detection**: without a once-per-leg guard, `departures[]` pollution breaks the
  cross-day diff baseline (reducer only dedupes identical `at`).
- **Device validation remains manual-only**: real Tasker task-loop behavior (if any exists beyond
  the documented single-invocation model) is outside the harness; device validation is still the
  deployment gate.

---

## Ready for Proposal

**Yes.** The orchestrator should tell the user:

1. FU1 is a **real production gap**, not hygiene: in the documented serial model only the last
   staged reducer command per Sandbox pass is delivered (evidence: Sandbox_Engine.js:426-438,
   Depart_Now.js:27-43, Return_to_Base.js:83-115, Finaliser.js:242-293, TDS_State_Command.js:443-456).
   The harness masks it (mock_tasker.js:94-103 synchronous shim; 28/28 green). Proposal should pick
   the **batch envelope** approach, add a production-faithful RED test, and migrate the adapters.
2. FU2 is **not urgent** — the `AUTO_REPLAN` API-conflict signal does not depend on departure
   records (Compiler.js:603-611), so the archive's stated trigger is unmet. Fold it in as a cheap
   tail slice after FU1 (edge-triggered Sandbox observation), or defer it; never before FU1.
