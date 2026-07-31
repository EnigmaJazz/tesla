# Exploration: tasker-tesla-upgrade-phase-3-trip-state-migration

Phase 3 introduces a **Trip State Reducer** that becomes the sole writer of a
new `TDS_Trip_State.json` file, and is the canonical owner of trip-lifecycle
state (PLANNED → DUE → IN_PROGRESS → ARRIVED → COMPLETED, plus MISSED /
SUPERSEDED / CANCELLED). The spec section this phase implements is `OWN-8`
(`RULE-8B`) plus the §4 `TRIP-4` lifecycle model, the §9 `CMD-9` command
contract, and the migration of four ephemeral globals that currently leak into
`TDS_Overrides.json` (`Depart_Memory`, `Completed_Stops`, `Completed_Dropins`,
`Arrival_Memory`). Authority: `openspec/specs/itinerary/spec.md` §4 / §8 / §9 /
§13 / §14 / §17.

The change is **NOT** a greenfield reducer. It is a structural migration with
real concurrency and ordering risk, because the four target globals are
currently mutated from three independent script families (Compiler, Finaliser,
Stop_Logger) plus the Alpha ingestion pass. The reducer has to be reachable
serially, has to keep the manifest publisher in lock-step, and has to centralise
the read-side `readActiveGeneration` copies that the four readers each carry.

## Current state

### What `TDS_Trip_State.json` is meant to be (per `OWN-8` / §3 / §4)

The spec describes a single JSON resource that holds:

- A `schemaVersion` / `revision` field (analogous to the manifest's).
- `currentOrigin` — one of `ACTIVE_MANUAL_TRIP`, `ACTIVE_PLANNED_TRIP`,
  `LIVE_BASE`, `LIVE_LOCATION`, `CONFIRMED_LAST_DESTINATION`,
  `OVERNIGHT_BASE_RESET`, `LEGACY_ITINERARY_FALLBACK`.
- A `trips` map keyed by `tripId` (which the §3 schema requires on every leg)
  with each value holding the `TRIP-4` state (`PLANNED` | `DUE` |
  `IN_PROGRESS` | `ARRIVED` | `COMPLETED` | `MISSED` | `SUPERSEDED` |
  `CANCELLED`) plus a `relevanceDeadlineUnix`, an `originSource`, a
  `planningDay`, and a `completionPolicy`.
- A `stops` map keyed by `stopId` (`stop:<eventId>:<ordinal>` per STOP-14).
- A `currentPlanningDay` derived from the configured local timezone (PLAN-5).

The state file does **not** exist today. The closest analogue is the
ephemeral state currently scattered across `TDS_Overrides.json` and Tasker
globals (`User_At_Base`, `Base_Arrival_Unix`, `TDS_Lateness_Halt`,
`TDS_Manual_Return_Completed`, `Current_Status`, `TDS_Previous_Loc`,
`TDS_Action_Lock.json`).

### What is currently being persisted (without a single owner)

Four OVR keys are today written by writers other than the planned Override
Handler. They are the Phase 3 migration surface:

| OVR key | Today (writer) | Future home |
|---|---|---|
| `Depart_Memory` | `Compiler.js:477, 480` (post-compile stage) | `TDS_Trip_State.trips[*].lastDeparture` |
| `Completed_Stops` | `Stop_Logger.js:42, 43` | `TDS_Trip_State.stops` (`COMPLETE_STOP` cmd) |
| `Completed_Dropins` | `Finaliser.js:125, 127` | `TDS_Trip_State.trips[*].state = ARRIVED` (idempotent) |
| `Arrival_Memory` | `Finaliser.js:112, 126` | `TDS_Trip_State.trips[*].arrivalUnix` (`OBSERVE_ARRIVAL` cmd) |

`TDS_Overrides.json` is supposed to be RULE-8C / Override-Handler-only. The
four leaks above are pre-existing OWN-8 violations, but moving them out is
the core of Phase 3.

### What is currently ephemeral (Tasker globals)

| Global | Set by | Read by |
|---|---|---|
| `User_At_Base` | `Sandbox_Engine.js:387, 389` | `Sandbox_Engine.js:385, 436, 511`, harness stubs |
| `Base_Arrival_Unix` | `Sandbox_Engine.js:387` | `Sandbox_Engine.js:440` |
| `TDS_Lateness_Halt` | `Depart_Now.js:42`, `Return_to_Base.js:92`, `Sandbox_Engine.js:294, 861, 955, 1027, 1243` | `Dashboard.js:241` |
| `TDS_Manual_Return_Completed` | (not yet set; slice-3 added the spec hook) | (slice-3 target) |
| `Current_Status` | `Sandbox_Engine.js` (status set), `Return_to_Base.js:91` | `Dashboard.js:73, 74`, `Sandbox_Engine.js:469` (regex) |
| `TDS_Previous_Loc` | (writer not found in 18 live scripts) | `Finaliser.js:72` |

`TDS_Previous_Loc` has a `readFile` consumer but no surviving live writer;
this is a pre-existing bug — Phase 3 should not fix it, but the reducer should
not depend on it.

## Current writers of trip-state-shaped data

These are the writers that Phase 3 has to dismantle or redirect. They are not
writers of `TDS_Trip_State.json` (the file does not exist) — they are the
writers of the state the new file will own.

```json
[
  { "file": "Compiler.js", "line": 477, "kind": "literal", "evidence": "OVR['Depart_Memory'] = newDepMem.join(\",\");" },
  { "file": "Compiler.js", "line": 480, "kind": "literal", "evidence": "writeFile(\"Tasker/Tesla/Data/TDS_Overrides.json\", JSON.stringify(OVR), false);" },
  { "file": "Finaliser.js", "line": 112, "kind": "literal", "evidence": "arrivalMemRaw += (arrivalMemRaw.length > 0 ? \",\" : \"\") + ev.id + \"~\" + nowSec;" },
  { "file": "Finaliser.js", "line": 125, "kind": "literal", "evidence": "mem['Completed_Dropins'] = completed.join(\",\");" },
  { "file": "Finaliser.js", "line": 126, "kind": "literal", "evidence": "mem['Arrival_Memory'] = arrivalMemRaw;" },
  { "file": "Finaliser.js", "line": 127, "kind": "literal", "evidence": "writeFile(\"Tasker/Tesla/Data/TDS_Overrides.json\", JSON.stringify(mem), false);" },
  { "file": "Stop_Logger.js", "line": 42, "kind": "literal", "evidence": "OVR['Completed_Stops'] = currentStops;" },
  { "file": "Stop_Logger.js", "line": 43, "kind": "literal", "evidence": "writeFile(ovrFile, JSON.stringify(OVR), false);" },
  { "file": "Alpha.js", "line": 430, "kind": "literal", "evidence": "writeFile(filePath, JSON.stringify(mem), false);" },
  { "file": "Alpha.js", "line": 387, "kind": "literal", "evidence": "let arraysToPrune = [ ..., \"Depart_Memory\", ..., \"Completed_Dropins\", \"Arrival_Memory\" ];" },
  { "file": "Sandbox_Engine.js", "line": 387, "kind": "global", "evidence": "setGlobal('User_At_Base', \"true\"); setGlobal('Base_Arrival_Unix', nowSec.toString());" },
  { "file": "Sandbox_Engine.js", "line": 389, "kind": "global", "evidence": "setGlobal('User_At_Base', \"false\");" },
  { "file": "Sandbox_Engine.js", "line": 294, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'false');" },
  { "file": "Sandbox_Engine.js", "line": 861, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'true'); queue = []; skipIdx = idx; blockMode = null; break;" },
  { "file": "Sandbox_Engine.js", "line": 955, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'true'); break;" },
  { "file": "Sandbox_Engine.js", "line": 1027, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'true'); break;" },
  { "file": "Sandbox_Engine.js", "line": 1243, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'true'); queue = []; skipIdx = idx; blockMode = null; break;" },
  { "file": "Depart_Now.js", "line": 42, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'false');" },
  { "file": "Return_to_Base.js", "line": 92, "kind": "global", "evidence": "setGlobal('TDS_Lateness_Halt', 'false');" },
  { "file": "Return_to_Base.js", "line": 91, "kind": "global", "evidence": "setGlobal('Current_Status', (modeDict[rMode] || \"Traveling\") + \" (Heading Home)\");" }
]
```

The `Override_Injector.js` write at line 142 is also a TDS_Overrides writer
but is a pre-existing OWN-8 violation that Phase 3 should not fix (it touches
non-trip-state override keys; out of scope per the orchestrator brief).

## Current readers of trip-state-shaped data

```json
[
  { "file": "Compiler.js", "line": 314, "what_it_reads": "OVR['Depart_Memory'] → inPending filter for re-staged legs" },
  { "file": "Finaliser.js", "line": 72, "what_it_reads": "global('TDS_Previous_Loc') → prior location for distance delta" },
  { "file": "Finaliser.js", "line": 79, "what_it_reads": "OVR['Completed_Dropins'] → suppress already-completed drop-ins from validEvents" },
  { "file": "Finaliser.js", "line": 80, "what_it_reads": "OVR['Arrival_Memory'] → first-seen arrival marker for the 200m radius latch" },
  { "file": "Sandbox_Engine.js", "line": 17, "what_it_reads": "OVR['Trimmed_Events'] (via getOvr)" },
  { "file": "Sandbox_Engine.js", "line": 18, "what_it_reads": "OVR['Completed_Stops'] (via getOvr)" },
  { "file": "Sandbox_Engine.js", "line": 19, "what_it_reads": "OVR['Skipped_Events'] (via getOvr)" },
  { "file": "Sandbox_Engine.js", "line": 385, "what_it_reads": "global('User_At_Base') → simAtBase / simAtLiveLocation" },
  { "file": "Sandbox_Engine.js", "line": 436, "what_it_reads": "global('User_At_Base') → location state" },
  { "file": "Sandbox_Engine.js", "line": 440, "what_it_reads": "global('Base_Arrival_Unix') → base arrival anchor" },
  { "file": "Sandbox_Engine.js", "line": 469, "what_it_reads": "global('Current_Status') → activeInProgress regex /^(Driving|Walking|Public Transport|Lift)/i" },
  { "file": "Sandbox_Engine.js", "line": 511, "what_it_reads": "global('User_At_Base') → live rebind" },
  { "file": "Dashboard.js", "line": 73, "what_it_reads": "global('Current_Status') → status banner" },
  { "file": "Dashboard.js", "line": 74, "what_it_reads": "global('Current_Status') → charging badge" },
  { "file": "Dashboard.js", "line": 241, "what_it_reads": "global('TDS_Lateness_Halt') → simulation-halt banner" },
  { "file": "Alpha.js", "line": 380, "what_it_reads": "OVR memory (prune pass over all 14 arrays incl. Depart_Memory / Completed_Dropins / Arrival_Memory)" }
]
```

## Divergent copies

The four `readActiveGeneration` copies each carry the same Phase 2
manifest-resolver logic. They are independently implemented and each has its
own `readJson`, `pathFor`, and legacy fallback. Phase 2 left them divergent
because there is no shared module in this codebase (Tasker JSlets do not
support `require`).

- `TDS_Helper.js:18-30` — `readActive(kind)` for `events|master|itinerary`.
  No legacy `TDS_Master.json` / `Itin_Master.json` fallback (the spec allows
  Phase 2 to keep readers strict); previous-generation fallback only.
- `Compiler.js:73-93` — `readActiveGeneration(kind)` (full Phase 2 resolver
  + legacy fallback for `events|master` and `itinerary`).
- `Dispatcher.js:52-72` — `readActiveGeneration(kind)` (full Phase 2 resolver
  + legacy fallback, same body as Compiler).
- `Dashboard.js:27-47` — `readActiveGeneration(kind)` (full Phase 2 resolver
  + legacy fallback, same body as Compiler / Dispatcher).
- `Sandbox_Engine.js:29-30` — `readJson` only; the resolver itself is the
  full `readActiveGeneration` defined at lines 70-108 (read in full earlier in
  the session, with the same manifest logic but with `events` legacy-less on
  some branches — not byte-identical to Compiler / Dispatcher / Dashboard).

All five converge on the same `TDS_Run_Manifest.json` contract but only three
(Compiler, Dispatcher, Dashboard) are byte-identical. The
`Sandbox_Engine.js` copy is functionally equivalent but adds the
`generationId` field for the manifest reader. `TDS_Helper.js` is the
shortest of the five. The duplication is the OWN-8-bypass the spec is
silent on, and Phase 3 is the natural place to centralise it.

`publishCandidate` (Phase 2) is duplicated:

- `Compiler.js:53-59` — `setLocal('par1', JSON.stringify(candidate))`; calls
  `publish(candidate)` if defined.
- `Finaliser.js:38-44` — same body, same call site.

The body is byte-identical. It is the post-Phase 2 handoff to the
Generation_Publisher and does not need to be in scope for the reducer
proper, but the proposal can call out the duplication for the same reason
as the `readActiveGeneration` copies.

## Trip lifecycle

Source: `openspec/specs/itinerary/spec.md` §4 (TRIP-4), §13 (MANUAL-13), §14
(STOP-14), §6 (SEL-6).

| State | Source | Meaning |
|---|---|---|
| `PLANNED` | TRIP-4 | Default; not yet due. |
| `DUE` | TRIP-4 | Inside the due window; Dispatcher must rank. |
| `IN_PROGRESS` | TRIP-4 | Movement / Depart Now / manual return / active chain. |
| `ARRIVED` | TRIP-4 | Within 150-200m of target (one or two good samples). |
| `COMPLETED` | TRIP-4 | Terminal; policy completed normally. |
| `MISSED` | TRIP-4 | Terminal; deadline expired without IN_PROGRESS or ARRIVED. |
| `SUPERSEDED` | TRIP-4 | Terminal; replaced by a newer generation. |
| `CANCELLED` | TRIP-4 | Terminal; explicit `CANCEL_ACTION`. |

Transitions (per `CMD-9` command set + TRIP-4 evidence):

| From | To | Trigger | Source command |
|---|---|---|---|
| `PLANNED` | `DUE` | Due-window opening (now ≥ relevanceDeadline − bucket) | `OBSERVE_DEPARTURE` (passive) |
| `DUE` | `IN_PROGRESS` | Depart Now / vehicle action / movement | `DEPART_NOW`, `OBSERVE_DEPARTURE` |
| `IN_PROGRESS` | `ARRIVED` | Two samples within 150-200m, or one good sample with acceptable accuracy | `OBSERVE_ARRIVAL` |
| `ARRIVED` | `COMPLETED` | Completion policy satisfied (drop-in duration / event end / EOD window) | `COMPLETE_TRIP` |
| `*` | `MISSED` | Now > relevanceDeadline without IN_PROGRESS or ARRIVED | `EXPIRE_TRIP` |
| `*` | `SUPERSEDED` | New committed generation published | (passive on commit) |
| `*` | `CANCELLED` | Explicit user cancel | `CANCEL_ACTION` |
| `COMPLETE_STOP` | (stop state) | `stop:<eventId>:<ordinal>` marks the planned stop done | `COMPLETE_STOP` |
| `START_UNPLANNED_STOP` / `END_UNPLANNED_STOP` | (unplanned stop state) | Manual or auto-marked | STOP-14 |

Hard rules that bind the reducer (from AGENTS.md):

- **No silent state inference.** Policy and origin must be explicit on the
  leg or in trip state. The reducer MUST not derive `departurePolicy` /
  `originSource` from `pitstopState`, `_IN` suffix, or `EOD_RETURN` mode.
- **No zero-duration published travel leg.** A leg with `durationSecs <= 0`
  and `apiType ∈ {DEPART, ARRIVE, ACTIVE_TRAVEL}` is rejected (Compiler
  already enforces; reducer must not undo the rejection).
- **No completion transferring ASAP to a later trip.** Tomorrow's first
  trip must remain `PLANNED` + `JIT` after today's trip completes.
- **No stale itinerary override of live location.** Reducer must trust
  `User_At_Base` and active trip state ahead of legacy itinerary.
- **No synthetic return for an empty day.** A return-to-base leg requires
  one of the four explicit policies (manual, recovery, EOD, safety /
  vehicle).
- **No day-boundary crossing chains.** The reducer's `currentPlanningDay`
  field enforces the boundary; the §5 invariants apply.

## Reducer shape

Source: §3 (SCH-3), §4 (TRIP-4), §8 (OWN-8 RULE-8B), §9 (CMD-9).

```
input_events = [
  SET_OVERRIDE, REMOVE_OVERRIDE,         // (not used by reducer; see OVR-10)
  DEPART_NOW,
  RETURN_TO_BASE,
  COMPLETE_STOP,
  START_UNPLANNED_STOP,
  END_UNPLANNED_STOP,
  CANCEL_ACTION,
  RESET_ACTIONS,
  OBSERVE_DEPARTURE,
  OBSERVE_ARRIVAL,
  COMPLETE_TRIP,
  EXPIRE_TRIP
]

state_shape = {
  schemaVersion: 1,
  generationId:  "<active gen or null>",
  currentOrigin: "ACTIVE_MANUAL_TRIP" | "ACTIVE_PLANNED_TRIP"
               | "LIVE_BASE" | "LIVE_LOCATION"
               | "CONFIRMED_LAST_DESTINATION"
               | "OVERNIGHT_BASE_RESET"
               | "LEGACY_ITINERARY_FALLBACK",
  currentPlanningDay: "YYYY-MM-DD",       // local TZ
  trips: {
    [tripId]: {
      state: "PLANNED" | "DUE" | "IN_PROGRESS" | "ARRIVED"
           | "COMPLETED" | "MISSED" | "SUPERSEDED" | "CANCELLED",
      tripId, generationId, legType, mode,
      originSource, planningDay, relevanceDeadlineUnix,
      lastDepartureUnix?, arrivalUnix?, completionPolicy?
    }
  },
  stops: {
    [stopId]: { tripId, ordinal, durationSecs, completedUnix }
  },
  manualSessions: { [actionId]: { ... } }   // §13 / MANUAL-13
}

output = new_state + (optionally) side effects:
  - setGlobal('TDS_Lateness_Halt', 'true'|'false')
  - setGlobal('User_At_Base', 'true'|'false')
  - setGlobal('Base_Arrival_Unix', nowSec)
  - setGlobal('Current_Status', statusString)
  - structured-log flash (one of §17 codes)
```

`TDS_Trip_State.json` is the file the reducer writes (RULE-8B). Tasker
serialises the read-modify-write through a single Tasker action; concurrent
invocations are not supported. The reducer does not need to be pure inside
the runtime — it has to be pure across `(state, event) → state` modulo the
side effects above.

## In scope

- `TDS_Trip_State.json` schema, writer, and read API.
- The Trip State Reducer script (new file) implementing the §9 command
  protocol and the §4 lifecycle transitions.
- Migration of the four OVR keys (`Depart_Memory`, `Completed_Stops`,
  `Completed_Dropins`, `Arrival_Memory`) out of `TDS_Overrides.json` and
  into the new state file.
- Migration of the `User_At_Base` / `Base_Arrival_Unix` / `TDS_Lateness_Halt`
  / `Current_Status` / `TDS_Manual_Return_Completed` globals into the
  reducer-managed `currentOrigin` / trip fields / side effects.
- Centralising the five `readActiveGeneration` copies into a single
  `TDS_Helper.js` export (or, if the helper is not appropriate, a new
  shared-resolver function the readers call). The manifest resolver is
  not a "trip state" responsibility per `OWN-8`, but it is the only way to
  keep readers in lock-step.
- Reading the new `TDS_Trip_State.json` from Sandbox, Compiler, Finaliser,
  Dispatcher, Dashboard, and the three command-adapter entry points.
- New harness test files for: (a) reducer command contract (13 commands,
  one test per command minimum); (b) lifecycle transitions; (c) origin
  precedence per INV-0.3; (d) day-boundary reset per INV-0.2; (e) post-
  return isolation per INV-0.5.
- The two `publishCandidate` copies (Compiler.js:53, Finaliser.js:38) MAY
  be in scope as a clean-up; the proposal should call this out as a
  cross-cutting tidy.

## Out of scope (per the orchestrator brief)

- The three pre-existing AGENTS.md hard-rule violations:
  1. `Override_Injector.js:142` writes `TDS_Overrides.json` (not the
     planned Override Handler). This is not the reducer's job; Phase 3
     should not touch it.
  2. The `id.split("_")[0]` style is still in `Appender.js:90` (line-number
     read of the existing AGENTS.md commentary) for `Route_Defaults` /
     `Route_History` keys. That is an OVR-10 / §10 follow-up.
  3. `indexOf(eventId)` substring-style membership checks remain in
     multiple readers (Compiler, Finaliser, Sandbox, Appender). The §10
     follow-up is a separate phase.
- Schema-v2 exact-key `eventOverrides` migration (OVR-10).
- `TDS_Routine_Preferences.json` and its sole-writer (Override Handler for
  the new prefs file). The reducer does not touch this.
- `TDS_Manual_Trips.json` / `TDS_Action_Sessions.json` (RULE-8D, Manual
  Action Handler) — the reducer MAY surface `manualSessions` for the
  command set, but the writer for those two files is a different
  responsibility and the proposal should not propose to write them.
- The `TDS_Previous_Loc` reader at `Finaliser.js:72` (no surviving live
  writer). This is a pre-existing bug; Phase 3 should not fix it.
- DST work in `Finaliser.js:60-62` (`setHours(0,0,0,0)` math). This is
  slice-3's work, not Phase 3.
- Refactoring legacy `var` → `let`/`const` in the modified files.

## Risks

- **Concurrency / read-modify-write races.** Tasker executes JSlet
  actions serially within a single Action, but multiple Actions (Compiler,
  Finaliser, Stop_Logger, Sandbox) can fire in the same tick. The
  §9 contract requires serialised execution. The reducer MUST be
  serialised behind a Tasker action; the proposal must not propose
  parallel writers. Risk: medium.
- **Atomic transitions.** A reducer event that mutates `state` AND
  publishes a side effect (e.g. `setGlobal('TDS_Lateness_Halt', ...)`) is
  two writes. Tasker does not give transactions across the file write and
  the global set. The Phase 2 manifest model uses read-after-write
  validation; the reducer should do the same for the file side and accept
  that the global side is best-effort with a structured-log audit.
  Risk: medium.
- **Retention.** `TDS_Trip_State.json` will accumulate trip records.
  The spec is silent on retention; Phase 2's `PHASE2_RETENTION = 5`
  pattern suggests a similar cap (e.g. last 30 days, or last N trips).
  The proposal must call out the choice. Risk: medium.
- **Manifest coordination.** When the Generation Publisher commits a
  new generation, the reducer must mark the prior trips
  `SUPERSEDED`. The reducer needs the new generation id from the
  manifest; it must not block on the publisher. The cleanest
  contract is: publisher calls `COMPLETE_TRIP` / `EXPIRE_TRIP` after
  commit. Risk: medium.
- **Origin precedence (INV-0.3).** The current `simAtBase` /
  `simAtLiveLocation` derivation in `Sandbox_Engine.js:436-511` and
  the `activeInProgress` regex at `Sandbox_Engine.js:469` are
  origin-state inferences that the reducer must own. The
  slice-3 exploration flagged this as a bug for AC-5. The Phase 3
  proposal must explicitly define how the reducer exposes
  `currentOrigin` and how the Sandbox consumes it. Risk: high —
  this is the single most important AGENTS.md hard rule
  ("No silent state inference").
- **Empty-day return (INV-0.4).** The reducer must refuse a synthetic
  return unless one of the four policies is present. Today the
  policy decision is spread across the planner and the
  `EOD_RETURN` mode marker. The reducer must own the policy
  discriminator. Risk: high.
- **Harness parity.** The 9 baseline harness tests must continue to
  pass. They touch `TDS_Overrides.json` indirectly through
  `User_At_Base` (e.g. `test_compiler_ac1.js:70`,
  `test_atomic_publication.js:199, 240, 511, 661, 821`). If the
  reducer owns `User_At_Base`, the harness stub mapping must
  keep the global in sync, or the harness must be migrated to
  read `TDS_Trip_State.json`. Risk: medium.
- **Multiple authoritative plans for `currentPlanningDay`.** The
  slice-3 spec delta for `INV-0.2` is UTC-based; §5 of the
  canonical spec is local-tz-based. Phase 3 must pick one and
  document the choice. Risk: low (clarification, not design).

## Open questions

- **Reducer entry-point shape.** The CMD-9 spec says "one serialised
  `TDS State Command` accepts `%par1` command type and `%par2` JSON
  payload". Is the reducer a single Tasker action invoked with
  `%par1` / `%par2`, or a JavaScript function called from within
  another JSlet? The Phase 2 `publishCandidate` precedent
  (`setLocal('par1', ...)` then a separate action) suggests a Tasker
  action. The proposal should pick the entry shape and document it.
- **Atomic reducer for `setGlobal` side effects.** Should the
  reducer write the file first, then set globals, or the other way
  around? Phase 2 chose read-after-write; the reducer should
  pick one and document the failure mode.
- **Retention policy.** N trips, N days, or unbounded? The
  proposal should pick a default.
- **Schema-revision migration path.** §3 says the trip state
  record has a `revision` field. Phase 2 used a single
  `MANIFEST_SCHEMA_VERSION = 1`. Phase 3 should either match
  that pattern or define a new revision scheme.
- **What happens to `TDS_Manual_Return_Completed`?** Slice 3 sets
  it as a global; Phase 3 owns the global. The reducer should
  consume it and emit `EVT-FUTURE_TRIP_NOT_DUE` accordingly. The
  proposal should call out the contract.
- **`TDS_Previous_Loc`.** Today's `Finaliser.js:72` reads it
  without a writer. Should Phase 3 (a) ignore it, (b) add the
  reducer as the writer, or (c) leave the bug for later? The
  reducer does not need it; option (a) is safest.

## Test surface

Current harness files (9):

- `harness/test_compiler_ac1.js` — touches `User_At_Base` stub.
- `harness/test_compiler_ac8.js` — touches `User_At_Base` stub.
- `harness/test_sandbox_ac6.js` — touches `User_At_Base` /
  `Base_Arrival_Unix`.
- `harness/test_atomic_publication.js` — touches `User_At_Base`
  at five sites (199, 240, 511, 661, 821) and `Base_Arrival_Unix`
  at 511.
- `harness/test_dispatcher_ac9.js`,
  `harness/test_dispatcher_ac10.js`,
  `harness/test_dispatcher_overdue_wins.js`,
  `harness/test_dispatcher_relevance.js`,
  `harness/test_dst_utc.js` — Dispatcher / DST tests; do not
  touch trip-state keys directly.

New tests Phase 3 should add:

- `harness/test_reducer_commands.js` — one scenario per `CMD-9`
  command. Uses the mock_tasker harness to invoke the reducer
  Tasker action with a state file and a command, and asserts the
  output state and the structured-log flash.
- `harness/test_trip_lifecycle.js` — TRIP-4 transitions:
  PLANNED → DUE → IN_PROGRESS → ARRIVED → COMPLETED, plus
  the three terminal cases (MISSED, SUPERSEDED, CANCELLED).
- `harness/test_origin_precedence.js` — INV-0.3:
  active manual beats live base beats last confirmed beats
  legacy itinerary.
- `harness/test_day_boundary.js` — INV-0.2:
  `currentPlanningDay` change forces `SUPERSEDED` for
  yesterday's trips.
- `harness/test_post_return_isolation.js` — INV-0.5:
  after a `COMPLETE_TRIP` of the return leg, the next-day
  first trip is `PLANNED` and not `DUE`.
- `harness/test_synthetic_return_rejection.js` — INV-0.4:
  planner submits a return with no policy; reducer rejects
  and flashes `SYNTHETIC_RETURN_SUPPRESSED`.

All 9 baseline tests must continue to pass. The proposal must
document the harness stub changes (or absence thereof).

## Estimated effort

- New script: `Trip_State_Reducer.js` (≈ 250–350 lines, given the
  Phase 2 publisher template).
- New schema constant in the spec delta: ~80 lines (the
  `TDS_Trip_State.json` schema block, scenarios for the
  13 commands, scenarios for the 8 lifecycle states).
- New harness test files: 6 new files, ~600–900 lines total.
- Files to modify (4): `Compiler.js` (remove OVR writes, read
  state file), `Finaliser.js` (same), `Stop_Logger.js` (same),
  `Alpha.js` (drop the 4 keys from the prune list, drop the
  OVR writers for them).
- Files to modify for the read-side cleanup (5): `TDS_Helper.js`
  (host the central resolver), `Compiler.js` / `Dispatcher.js` /
  `Dashboard.js` / `Sandbox_Engine.js` (delegate to the
  central resolver).
- Optional: centralise `publishCandidate` (2 file change,
  ~10 lines total).

Total: 2 new files, ~9 modified files, ~1500–2000 lines including
tests. This is well above the 400-line review budget for a single
PR.

### Chain recommendation

The change must be split into a stack:

1. **PR 1 — Schema + Reducer shell.** Trip State Reducer script
   with the schema, the entry-point contract, the 13 commands
   implemented as no-ops (or rejecting every command with a
   structured-log flash), and the harness stub. No readers, no
   writers removed. Baseline tests still pass.
2. **PR 2 — Migration of `Completed_Dropins` and `Arrival_Memory`.**
   `Finaliser.js` becomes a command adapter; the two keys stop
   being written to `TDS_Overrides.json`. Alpha's prune list
   drops them. `TDS_Trip_State.json` is read by the Sandbox
   for drop-in suppression.
3. **PR 3 — Migration of `Completed_Stops`.** `Stop_Logger.js`
   becomes a `COMPLETE_STOP` command adapter. Sandbox reads
   the reducer's stop state.
4. **PR 4 — Migration of `Depart_Memory`.** `Compiler.js`
   becomes a `OBSERVE_DEPARTURE` adapter on the head leg of
   the published chain.
5. **PR 5 — Read-side centralisation.** The five
   `readActiveGeneration` copies collapse to the TDS_Helper
   host. Sandbox-specific resolver (the divergent one in
   `Sandbox_Engine.js`) is unified here.
6. **PR 6 — Optional clean-up.** `publishCandidate` duplication
   is removed; Finaliser and Compiler both call the publisher
   through a shared Tasker action.

Chain recommended: **true**. A single PR would breach the 400-line
review budget and would touch all 9 scripts simultaneously — exactly
the review-unfriendly pattern the orchestrator brief warned about.

Review budget risk: **high** if forced into one PR; **low** if
chained.

## Ready for proposal

Yes. The scope, schema, command set, lifecycle states, harness
parity, and chain are well-defined from the canonical spec. The
orchestrator should:

- Open the proposal for the first PR of the chain
  (schema + reducer shell).
- Ask the user to confirm the entry-point shape (Tasker
  action vs. in-script function) and the retention policy
  before proposal generation, since both are user-facing
  design choices not answered by the spec.
- Then proceed to `propose`.
