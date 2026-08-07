# Delta for itinerary

> Supplements §9 CMD-9, §23 REQ-4CMD-1, and §25 Phase 6 (REQ-6STATE-4) of `openspec/specs/itinerary/spec.md`.
> **Canonical-spec sync required on archive merge:** add `REDUCER_BATCH` to the §9 CMD-9 command list; merge REQ-4CMD-1 scenarios and REQ-6STATE-4 text below into the canonical §23/§25 blocks.

## ADDED Requirements

### Requirement: REQ-6FU-1 — Batch envelope delivery

The planning engine SHALL register a `REDUCER_BATCH` command in the §9 CMD-9 command surface. `stageReducerCommand` SHALL accumulate every observation staged during one Sandbox pass into an ordered array and, at pass end, stage exactly one `REDUCER_BATCH` envelope with `par2 = {commands:[{command,payload},...]}` preserving staging order. The router SHALL deliver the envelope to the reducer as one owner entry; the reducer SHALL apply each sub-command in order. A serial-faithful harness (Sandbox run without the synchronous reducer shim, then `TDS_State_Command` invoked once) MUST prove all staged observations reach trip state. No sub-command SHALL be silently dropped to last-wins behaviour.

#### Scenario: SCN-6FU-1A [EVT: `REDUCER_BATCH_DELIVERED`] — production-loss RED baseline

- GIVEN the serial Tasker model where only the final `par1`/`par2` reaches `TDS_State_Command` and the reducer shim is absent (production-faithful harness)
- WHEN a pass stages `OBSERVE_LIVE_BASE`, `COMPLETE_TRIP`, and `OBSERVE_LATENESS_HALT`
- THEN today's last-wins delivery SHALL land only `OBSERVE_LATENESS_HALT`
- AND `userAtBase`/`currentStatus`/base-arrival completion MUST NOT be applied, proving the production loss

#### Scenario: SCN-6FU-2 [EVT: `REDUCER_BATCH_DELIVERED`] — batch delivery

- GIVEN the same serial-faithful harness after the batch fix
- WHEN one `REDUCER_BATCH` envelope reaches `TDS_State_Command`
- THEN the reducer MUST apply every sub-command in staging order
- AND all staged observations SHALL land in trip state with no silent drop

#### Scenario: SCN-6FU-3 [EVT: `REDUCER_BATCH_DELIVERED`] — degenerate single-observation pass

- GIVEN a pass stages exactly one observation followed by the always-run halt reset
- WHEN the batch envelope is delivered
- THEN the single observation MUST still apply in order and the halt reset MUST follow it

### Requirement: REQ-6FU-2 — Partial-failure semantics

The reducer SHALL apply valid sub-commands in order and log-and-skip invalid ones. An invalid sub-command within a batch MUST be rejected with a structured `BATCH_SUBCOMMAND_REJECTED` event and MUST NOT mutate state; valid sub-commands before and after it MUST still apply. All-or-nothing.batch rejection is forbidden: one bad payload MUST NOT drop independent valid observations. Per-sub-command validate/commit/project discipline SHALL be preserved.

#### Scenario: SCN-6FU-4 [EVT: `BATCH_SUBCOMMAND_REJECTED`]

- GIVEN a batch with one malformed `COMPLETE_TRIP` payload between valid `OBSERVE_LIVE_BASE` and `OBSERVE_STATUS`
- WHEN the envelope is applied
- THEN the middleware sub-command MUST be logged-and-skipped without mutation
- AND the two valid sub-commands MUST both apply in order

#### Scenario: SCN-6FU-5 — all-valid batch applies all

- GIVEN a batch whose every sub-command is valid
- WHEN the envelope is applied
- THEN every sub-command MUST commit and project without any skip

### Requirement: REQ-6FU-3 — Nested validation parity

Each batch sub-command MUST be validated byte-exact against the same field contracts as a direct command (`REDUCER_REQUIRED_FIELDS` parity per §23 REQ-4CMD-1). A malformed batch envelope shape (missing `commands`, non-array, non-object entries) MUST be rejected without mutating any owner, preserving §23 no-mutation on top-level rejection. Batch size SHALL be bounded by a named constant; an oversized batch SHALL be rejected with a structured code.

#### Scenario: SCN-6FU-6 [EVT: `BATCH_ENVELOPE_REJECTED`]

- GIVEN `par1 = REDUCER_BATCH` with `par2` missing `commands` or non-array
- WHEN `TDS_State_Command` validates it
- THEN no owner or file MUST change and `BATCH_ENVELOPE_REJECTED` MUST be logged

#### Scenario: SCN-6FU-7 [EVT: `BATCH_SUBCOMMAND_REJECTED`] — nested field parity

- GIVEN a sub-command whose payload fails the matching `REDUCER_REQUIRED_FIELDS` entry
- WHEN the reducer validates it in-order
- THEN it MUST be skipped as in REQ-6FU-2 with byte-identical rejection semantics to a direct invalid command

### Requirement: REQ-6FU-4 — Adapter observation migration

`Depart_Now.js`, `Return_to_Base.js`, and `Finaliser.js` observations that the serial model would otherwise clobber SHALL route through the batch mechanism so no secondary observation is sacrificed. Where the primary command MUST be the delivered envelope (the Finaliser publish/release sequence), the existing `tds_release_par1/par2` mid-chain rule SHALL be retained so the primary command remains last.

#### Scenario: SCN-6FU-8 [EVT: `REDUCER_BATCH_DELIVERED`] — adapter secondary observations delivered

- GIVEN Depart_Now stages `OBSERVE_LATENESS_HALT` then `DEPART_NOW`
- WHEN the batch envelope is delivered serially
- THEN both the halt observation and the departure MUST reach the reducer with neither sacrificed

#### Scenario: SCN-6FU-9 [EVT: `STATE_PROJECTION_SKIPPED`] — Finaliser primary-last retained

- GIVEN Finaliser's publish/release chain
- WHEN it stages its observations
- THEN the release candidate MUST remain the primary-last staged command and the mid-chain `tds_release_par1/par2` rule SHALL be preserved

### Requirement: REQ-6FU-5 — Non-base-origin departure observation (tail)

In the Sandbox active-leg window, when the head leg enters its departure window while `!currentlyAtBase`, the Sandbox SHALL stage `OBSERVE_DEPARTURE` with the head leg's event identity, completing REQ-6STATE-4 for non-base-origin JIT departures. It SHALL fire at most once per leg per pass, guarded against the last `departures[]` record for that trip matching the current planning-day/window entry. It MUST NOT double-observe a base-leave departure, and cross-day `departChanged`/`departDiffMins` baseline SHALL remain preserved. This requirement is gated on REQ-6FU-1; it MUST NOT ship before batch staging.

#### Scenario: SCN-6FU-10 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`] — non-base origin

- GIVEN a JIT head leg whose origin is away (`currentlyAtBase=false`, `prevAtBase=false`) and is entering its departure window
- WHEN the Sandbox active-leg window runs
- THEN `OBSERVE_DEPARTURE` MUST stage for that leg's event identity
- AND the reducer MUST store the departure on commit (REQ-6STATE-4 cross-day diff applies)

#### Scenario: SCN-6FU-11 [EVT: `BATCH_SUBCOMMAND_REJECTED`] — once-per-leg guard

- GIVEN the leg was already observed for this planning-day/window entry in `departures[]`
- WHEN the same active-leg window re-enters on a later pass
- THEN no further `OBSERVE_DEPARTURE` SHALL stage for that leg
- AND the cross-day diff baseline MUST NOT be polluted

## MODIFIED Requirements

### Requirement: REQ-4CMD-1

`TDS_State_Command` MUST serially validate `par1`/`par2`, route only to Reducer, Override Handler, Manual Action Handler, or Publisher, and reject without mutation. A `REDUCER_BATCH` envelope is a supported command routed to the Reducer; its sub-commands SHALL be validated byte-exact against `REDUCER_REQUIRED_FIELDS` (REQ-6FU-3), and a rejected envelope or sub-command SHALL preserve no-mutation. A `REDUCER_BATCH` envelope MUST occupy exactly one owner entry.

(Previously: validated single commands only; no batch envelope surface or nested-field parity.)

#### Scenario: SCN-4CMD-1 [EVT: `STATE_COMMAND_ROUTED`]
- GIVEN a supported envelope
- WHEN routed
- THEN exactly one declared owner MUST receive it

#### Scenario: SCN-4CMD-2 [EVT: `STATE_COMMAND_REJECTED`]
- GIVEN malformed JSON or an unknown command
- WHEN validated
- THEN no owner or file MUST change

#### Scenario: SCN-4CMD-3 [EVT: `REDUCER_BATCH_DELIVERED`] — batch routed (added)
- GIVEN `par1 = REDUCER_BATCH` with a valid `par2.commands` array
- WHEN `TDS_State_Command` routes it
- THEN exactly the Reducer MUST receive it as one owner entry and apply sub-commands in order

### Requirement: REQ-6STATE-4

A production component SHALL stage `OBSERVE_DEPARTURE` with the event identity, preserving cross-day departure-diff semantics: `departChanged`/`departDiffMins` SHALL compare against the previous day's actual departure for the same event, not a same-day reconstruction. The departures recorded in trip state SHALL be the sole authority for this comparison. The caller scope SHALL cover both base-leave departures (`!currentlyAtBase && prevAtBase`) and non-base-origin head-leg departures (head leg entering its departure window while `!currentlyAtBase`, once per leg — REQ-6FU-5).

(Previously: covered base-leave departures only; non-base-origin JIT departures were not observed.)

#### Scenario: SCN-6STATE-7 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`]
- GIVEN a production departure observation for a planned event
- WHEN `OBSERVE_DEPARTURE` is staged and committed
- THEN the departure record MUST be stored and cross-day diff MUST be computed against the prior day's actual departure

#### Scenario: SCN-6STATE-8 [EVT: `OBSERVE_DEPARTURE_ACCEPTED`] — non-base origin (added)
- GIVEN a JIT head leg departing from a non-base origin
- WHEN the Sandbox active-leg window stages `OBSERVE_DEPARTURE` (REQ-6FU-5) and the batch delivers it
- THEN the departure record MUST be stored and the cross-day diff baseline MUST reflect the actual departure