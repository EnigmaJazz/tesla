# Archive Report: tasker-tesla-upgrade-phase-6-followups

**Status**: complete — delivered, verified PASS WITH WARNINGS, native review approved, archived.
**Archived**: 2026-08-08.
**Artifact store**: openspec
**Archive location**: `openspec/changes/archive/2026-08-08-tasker-tesla-upgrade-phase-6-followups/` (moved via `git mv`). Delta merged into `openspec/specs/itinerary/spec.md` (§9 CMD-9 list; §23 REQ-4CMD-1; §25 REQ-6STATE-4; new §26 with REQ-6FU-1…5).
**Cycle verdict**: PASS WITH WARNINGS — 7 requirements (5 ADDED + 2 MODIFIED), 12 scenarios, harness 30/30, zero CRITICAL.

## Date and Delivery

| Step | Date | What |
|---|---|---|
| PR 39 (FU1 core) | 2026-08-08 | `19b84d5` merged to master — `REDUCER_BATCH` envelope: `stageReducerCommand` accumulation, router one-owner-entry routing, ordered sub-command apply in the reducer, `REDUCER_BATCH_DELIVERED` / `BATCH_ENVELOPE_REJECTED` / `BATCH_SUBCOMMAND_REJECTED` log codes, serial-faithful RED harness (last-wins baseline), tests. |
| PR 40 (FU1 core) | 2026-08-08 | `9931259` merged — partial-failure semantics, nested validation parity, Depart_Now/Return_to_Base adapter observation migration, `TDS_State_Command.REDUCER_COMMANDS` registration, tests. |
| PR 41 (FU1 core) | 2026-08-08 | `924ec16` merged — SCN-6FU-6/7 byte-exact nested parity checks, batch size bound constant, structured rejection codes, tests. |
| PR 42 (FU2 tail) | 2026-08-08 | `5feb699` merged — non-base-origin departure observation: Sandbox active-leg window `OBSERVE_DEPARTURE` staging, once-per-leg guard, `test_fu2_departure_edge.js`, cross-day baseline preservation, tests. |
| PR 2 (Finaliser obs migration) | 2026-08-08 | **DEFERRED by user decision D5 (b)** — recorded in `tasks.md` (2.1–2.3 `SUPERSEDED by D5 (b)`, 2.4 records the deferral dated 2026-08-08). `Finaliser.js` untouched (0 `REDUCER_BATCH` matches). Becomes its own follow-up change. |
| Verify | 2026-08-08 | PASS WITH WARNINGS — 7/7 requirements, 12/12 scenarios, harness 30/30 exit 0 (no CRITICAL). W1 + W2 recorded; S1 recorded for archive-time execution. |
| Native review | 2026-08-08 | Lineage `review-cb2af7e1a5d97629` bound to the change; post-apply gate **approved** (allow), terminal receipt published. |

## Verification (final)

- **Verdict**: PASS WITH WARNINGS — delta spec defines 7 requirements (REQ-6FU-1…5 ADDED; REQ-4CMD-1, REQ-6STATE-4 MODIFIED) and 12 scenarios (SCN-6FU-1A,2,4,5,6,7,8,9,10,11 + SCN-4CMD-3 + added SCN-6STATE-8 in the delta).
- Harness: 30/30 green, exit 0, all `test_*.js` under `harness/`.
- Test command: `for f in harness/test_*.js; do node $f; done`.
- No failing test, no CRITICAL finding, no unchecked core task.

## Warning W1 — Finaliser dropin/arrival observation migration deferred (D5)

REQ-6FU-4's requirement text states "Finaliser.js observations the serial model would clobber SHALL route through the batch mechanism." By the explicit user decision D5 (b) (recorded in `tasks.md` tasks 2.1–2.4, dated 2026-08-08), the Finaliser dropin/arrival observation migration is **deferred to a follow-up change** and `Finaliser.js` remains untouched (grep `REDUCER_BATCH Finaliser.js` → 0 matches). SCN-6FU-9 (retain the `tds_release_par1/par2` mid-chain primary-last rule) is satisfied because the rule is preserved by the unchanged Finaliser (`finaliser-midchain-preserves-par1-and-stages-release` PASS). This is a WARNING, not CRITICAL: all testable scenarios are covered, the deferral is a recorded user decision, and the SUPERSEDED tasks are checked so no core task is unchecked. The Finaliser dropin/arrival observation loss in production is a distinct follow-up deliverable.

**Deferred follow-up (this change's scope ends here):** Finaliser dropin/arrival observations migration to the batch mechanism — becomes its own change, tracking the W1 deferral.

## Warning W2 — EVT alias mismatch (recorded deviation)

The spec EVT alias `OBSERVE_DEPARTURE_ACCEPTED` (used by SCN-6FU-10/11, SCN-6STATE-7 and the delta's added SCN-6STATE-8) is not a real reducer log code. The `REDUCER_BATCH` delivery path logs `REDUCER_BATCH_DELIVERED` with `{count, applied, skipped}`; an accepted individual `OBSERVE_DEPARTURE` emits `TRIP_STATE_COMMAND_ACCEPTED`. Covering tests (`test_fu2_departure_edge.js`, `test_serial_batch.js`) assert applied-count totals (e.g. 4 + 2 = 6) rather than the nonexistent code (recorded deviation #2 in `apply-progress.md`). Scenario compliance is proven at runtime; the EVT alias remains aspirational. Not blocking. Follow-up option: add a real `OBSERVE_DEPARTURE_ACCEPTED` code or align the spec EVT to `REDUCER_BATCH_DELIVERED` / `TRIP_STATE_COMMAND_ACCEPTED`.

## Archive-time Canonical Sync (verify S1/W2 + task 4.1)

- **§9 CMD-9** (~line 101): `REDUCER_BATCH` added to the command list with the `par2.commands` ordered sub-command owner-entry note, per the delta's canonical-sync note and verify suggestion S1.
- **§23 REQ-4CMD-1**: requirement text extended with the batch envelope clause (byte-exact `REDUCER_REQUIRED_FIELDS` validation via REQ-6FU-3); `(Previously: …)` provenance line; `SCN-4CMD-3` batching: routes scenario added.
- **§25 REQ-6STATE-4**: requirement text extended to cover non-base-origin head-leg departures (REQ-6FU-5); `SCN-6STATE-7` reworded to the delta wording; added scenario renamed **`SCN-6STATE-12`** — the delta's added scenario was named `SCN-6STATE-8`, which collides with the pre-existing canonical `SCN-6STATE-8` (REQ-6STATE-5, vestigial paths). Renumbered to `SCN-6STATE-12` at merge so scenario IDs stay unique in the canonical; renamed `(Previously: …)` for base-leave origin recorded.
- **§26 (Phase 6 Follow-ups — Batch Envelope Delivery & Non-Base-Origin Departure)**: new section appended with REQ-6FU-1..5 and scenarios SCN-6FU-1A,2,4,5,6,7,8,9,10,11, following the established append pattern (mirrors how `2026-08-07-tasker-tesla-upgrade-phase-6-state-decomposition` appended §25).
- **AGENTS.md Logging expectations** (verify suggestion S2): reported-event codes `REDUCER_BATCH_DELIVERED`, `BATCH_ENVELOPE_REJECTED`, `BATCH_SUBCOMMAND_REJECTED` added to the required codes enumeration.
- No new single-writer resource; reducer remains sole writer of `TDS_Trip_State.json`.

## Deferred Follow-ups (explicitly deferred, NOT blockers)

1. **Finaliser dropin/arrival observation migration** — the D5 (b) deferral (W1). Finaliser.js is untouched; this becomes its own change.
2. **`OBSERVE_DEPARTURE_ACCEPTED` EVT alias** — spec EVT does not match a real reducer log code (W2/recorded deviation #2). Align spec or add the code in a follow-up.

## Archive Verification

- Change folder moved to `openspec/changes/archive/2026-08-08-tasker-tesla-upgrade-phase-6-followups/` with all artifacts (exploration, proposal, specs, design, tasks, apply-progress, verify-report, archive-report).
- Active changes dir no longer contains this change; `openspec/changes/` holds only `archive/`.
- `tasks.md` has 31/31 `[x]` implementation tasks at archive time- no stale unchecked tasks (the D5 SUPERSEDED tasks are checked with recorded reason).
- Archive is an audit trail — no archived content was deleted or modified beyond this report (the canonical-spec merge happened on the live spec; the archived delta spec is untouched).
- Merge was non-destructive (append-only §26 + in-place REQ-4CMD-1 / REQ-6- STATE-4 text merges + `REDUCER_BATCH` list entry); no destructive-slice warning needed per `rules.archive`.