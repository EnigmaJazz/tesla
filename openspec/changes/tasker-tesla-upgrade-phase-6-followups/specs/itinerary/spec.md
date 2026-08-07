# Delta for itinerary

> Supplements §9 CMD-9, §23 REQ-4CMD-1, §25 REQ-6STATE-4 of `openspec/specs/itinerary/spec.md`.
> **Canonical-sync on archive:** add `REDUCER_BATCH` to §9 CMD-9 command list; merge REQ-4CMD-1/REQ-6STATE-4 edits below into the canonical §23/§25 blocks.

## ADDED Requirements

### Requirement: REQ-6FU-1 — Batch envelope delivery

The planning engine SHALL register a `REDUCER_BATCH` command in the §9 CMD-9 surface. `stageReducerCommand` SHALL accumulate every observation staged in one Sandbox pass into an ordered array and, at pass end, stage one `REDUCER_BATCH` envelope with `par2 = {commands:[{command,payload},...]}` preserving staging order. The router SHALL deliver it to the reducer as one owner entry; the reducer SHALL apply each sub-command in order. A serial-faithful harness (Sandbox run without the reducer shim, then `TDS_State_Command` invoked once) MUST prove all observations reach trip state; none SHALL be silently dropped to last-wins.

#### Scenario: SCN-6FU-1A — production-loss RED baseline
- GIVEN the serial Tasker model (reducer shim absent in harness) where only the final `par1`/`par2` reaches `TDS_State_Command`
- WHEN a pass stages `OBSERVE_LIVE_BASE`, `COMPLETE_TRIP`, `OBSERVE_LATENESS_HALT`
- THEN last-wins SHALL land only the halt and `userAtBase`/`currentStatus`/base-arrival completion MUST NOT apply

#### Scenario: SCN-6FU-2 [EVT: `REDUCER_BATCH_DELIVERED`] — batch delivery
- GIVEN the same serial-faithful harness after the batch fix
- WHEN one `REDUCER_BATCH` envelope reaches `TDS_State_Command`
- THEN the reducer MUST apply every sub-command in order into trip state with no drop

### Requirement: REQ-6FU-2 — Partial-failure semantics

The reducer SHALL apply valid sub-commands in order and log-and-skip invalid ones. An invalid sub-command MUST be logged (`BATCH_SUBCOMMAND_REJECTED`) and skip mutation; valid sub-commands before and after MUST still apply. All-or-nothing batch rejection is forbidden — one bad payload MUST NOT drop independent valid observations. Per-sub-command validate/commit/project discipline SHALL be preserved.

#### Scenario: SCN-6FU-4 [EVT: `BATCH_SUBCOMMAND_REJECTED`]
- GIVEN a malformed `COMPLETE_TRIP` payload between valid `OBSERVE_LIVE_BASE` and `OBSERVE_STATUS`
- WHEN applied, THEN it MUST skip-mutate-and-log and both valid sub-commands MUST apply in order

#### Scenario: SCN-6FU-5 — all-valid batch
- GIVEN every sub-command valid, WHEN applied, THEN every sub-command MUST commit-and-project

### Requirement: REQ-6FU-3 — Nested validation parity

Each sub-command MUST be validated byte-exact against the same field contracts as a direct command (`REDUCER_REQUIRED_FIELDS` parity, §23). A malformed envelope (missing `commands`, non-array, non-object entry) MUST be rejected without mutating any owner. A named constant SHALL bound batch size; oversized batches SHALL be rejected with a structured code.

#### Scenario: SCN-6FU-6 [EVT: `BATCH_ENVELOPE_REJECTED`]
- GIVEN `par1 = REDUCER_BATCH` with `par2.commands` missing or non-array
- WHEN validated, THEN no owner or file MUST change

#### Scenario: SCN-6FU-7 [EVT: `BATCH_SUBCOMMAND_REJECTED`] — nested parity
- GIVEN a sub-command payload failing its `REDUCER_REQUIRED_FIELDS` entry
- WHEN validated in-order, THEN it MUST skip with byte-identical rejection semantics to a direct invalid command

### Requirement: REQ-6FU-4 — Adapter observation migration

`Depart_Now.js`, `Return_to_Base.js`, and `Finaliser.js` observations the serial model would clobber SHALL route through the batch mechanism so no secondary observation is sacrificed. Where the primary command MUST be the delivered envelope (the Finaliser publish/release sequence), the existing `tds_release_par1/par2` mid-chain rule SHALL be retained so the primary command remains last.

#### Scenario: SCN-6FU-8 [EVT: `REDUCER_BATCH_DELIVERED`]
- GIVEN Depart_Now stages `OBSERVE_LATENESS_HALT` then `DEPART_NOW`
- WHEN delivered serially, THEN both MUST reach the reducer with neither sacrificed

#### Scenario: SCN-6FU-9 [EVT: `STATE_PROJECTION_SKIPPED`]
- GIVEN the Finaliser publish/release chain, WHEN staged
- THEN the release candidate MUST remain primary-last and the `tds_release_par1/par2` rule SHALL be preserved

### Requirement: REQ-6FU-5 — Non-base-origin departure observation (tail)

In the Sandbox active-leg window, when the head leg enters its departure window while `!currentlyAtBase`, the Sandbox SHALL stage `OBSERVE_DEPARTURE` with the head leg's event identity, completing REQ-6STATE-4 for non-base-origin JIT departures. It SHALL fire at most once per leg per pass, guarded against the last `departures[]` record for that trip matching the current planning-day/window entry. It MUST NOT double-observe a base-leave; cross-day `departChanged`/`departDiffMins` baseline SHALL remain preserved. Gated on REQ-6FU-1.

#### Scenario: SCN-6FU-10 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`] — non-base origin
- GIVEN a JIT head leg away (`currentlyAtBase=false`, `prevAtBase=false`) entering its departure window
- WHEN the active-leg window runs, THEN `OBSERVE_DEPARTURE` MUST stage and the reducer MUST store it on commit

#### Scenario: SCN-6FU-11 [EVT: `BATCH_SUBCOMMAND_REJECTED`] — once-per-leg guard
- GIVEN the leg was already observed for this planning-day/window entry
- WHEN the window re-enters later, THEN no further `OBSERVE_DEPARTURE` SHALL stage and the diff baseline MUST NOT pollute

## MODIFIED Requirements

### Requirement: REQ-4CMD-1

`TDS_State_Command` MUST serially validate `par1`/`par2`, route only to Reducer, Override Handler, Manual Action Handler, or Publisher, and reject without mutation. A `REDUCER_BATCH` envelope is a supported command routed to the Reducer as one owner entry; its sub-commands SHALL be validated byte-exact against `REDUCER_REQUIRED_FIELDS` (REQ-6FU-3) and a rejected envelope or sub-command SHALL preserve no-mutation.

(Previously: single commands only; no batch surface or nested-field parity.)

#### Scenario: SCN-4CMD-1 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a supported envelope, WHEN routed, THEN exactly one declared owner MUST receive it

#### Scenario: SCN-4CMD-2 [EVT: `STATE_COMMAND_REJECTED`]
- GIVEN malformed JSON or unknown command, WHEN validated, THEN no owner or file MUST change

#### Scenario: SCN-4CMD-3 [EVT: `REDUCER_BATCH_DELIVERED`] — batch routed (added)
- GIVEN `par1 = REDUCER_BATCH` with valid `par2.commands`, WHEN routed
- THEN exactly the Reducer MUST receive it as one owner entry and apply sub-commands in order

### Requirement: REQ-6STATE-4

A production component SHALL stage `OBSERVE_DEPARTURE` with the event identity, preserving cross-day departure-diff semantics: `departChanged`/`departDiffMins` SHALL compare against the previous day's actual departure for the same event, not a same-day reconstruction; departures in trip state SHALL be the sole authority. The caller scope SHALL cover both base-leave departures (`!currentlyAtBase && prevAtBase`) and non-base-origin head-leg departures (head leg entering its departure window while `!currentlyAtBase`, once per leg — REQ-6FU-5).

(Previously: base-leave departures only; non-base-origin JIT departures were not observed.)

#### Scenario: SCN-6STATE-7 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`]
- GIVEN a production departure observation for a planned event
- WHEN staged and committed, THEN the record MUST be stored and cross-day diff MUST compare against the prior day's actual departure

#### Scenario: SCN-6STATE-8 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`] — non-base origin (added)
- GIVEN a JIT head leg departing from a non-base origin
- WHEN the Sandbox active-leg window stages `OBSERVE_DEPARTURE` (REQ-6FU-5) and the batch delivers it
- THEN the record MUST be stored and the cross-day diff baseline MUST reflect the actual departure