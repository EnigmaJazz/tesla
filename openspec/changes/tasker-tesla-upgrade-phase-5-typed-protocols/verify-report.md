```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:addba56ae4729fc3b8432f51f759ed5b5ac5c816519cf357be948d9ab512f0ff
verdict: pass
blockers: 0
critical_findings: 0
requirements: 3/3
scenarios: 6/6
test_command: for t in harness/test_*.js; do node "$t" || exit 1; done
test_exit_code: 0
test_output_hash: sha256:93b5a5e37b8c70deb8e0709c4b183d0cc493450d17a31065d63837fc5267e97c
build_command: for f in *.js harness/*.js; do node --check "$f" || exit 1; done
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## Verification Report

**Change**: tasker-tesla-upgrade-phase-5-typed-protocols — Slice A (PR-A), run 5 (post-crash recovery; ledger attempt `slice-a-run-5-verification` settled passed)  
**Version**: Proposed delta  
**Mode**: Standard (Strict TDD disabled)  
**Branch verified**: `tasker-tesla-phase5-pr-a`  
**HEAD verified**: `4543e301b10ef1b45b2a29381d3418e630700e8d`  
**Slice commits**: `993f676`, `066a9e6`, `bceb752`, `08725ca`, `422f960`, `4543e30`

### Completeness

| Metric | Value |
|---|---:|
| Slice A tasks total | 3 |
| Slice A tasks complete | 3 |
| Slice A tasks incomplete | 0 |
| Full change tasks complete | 3/12 |
| In-scope top-level requirements | 3 |
| In-scope scenarios | 6 |

Slice B-D tasks remain outside this scoped PR-A assessment. The full SDD change is not ready for final full-change verification or archive.

### Build & Tests Execution

**Focused Slice A harnesses**: ✅ 12/12 scripts passed

```text
Command: for t in harness/test_typed_queue.js harness/test_ac3_sandbox.js harness/test_ac5.js harness/test_atomic_publication.js harness/test_compiler_ac1.js harness/test_compiler_ac8.js harness/test_dst_utc.js harness/test_id_parsing.js harness/test_manual_session.js harness/test_sandbox_ac6.js harness/test_sandbox_ovr10.js harness/test_single_writer.js; do node "$t" || exit 1; done
Exit: 0
Scripts: 12/12
Output hash: sha256:74d45e4a89f900ed0f1084185c04a9abdfd8623fb937f6814f6516fba10a115e
```

**Full suite**: ✅ 25/25 scripts passed

```text
Command: for t in harness/test_*.js; do node "$t" || exit 1; done
Exit: 0
Scripts: 25/25
Output hash: sha256:93b5a5e37b8c70deb8e0709c4b183d0cc493450d17a31065d63837fc5267e97c
```

**Build/syntax**: ✅ 50/50 JavaScript files passed `node --check`

```text
Command: for f in *.js harness/*.js; do node --check "$f" || exit 1; done
Exit: 0
Files: 50/50
Output hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

**Adversarial complete-envelope control probe**: ✅ Passed

```text
Command: inline Node probe using harness/mock_tasker.js and Compiler.js
Exit: 0
Output hash: sha256:a011b4f49dcb575c61a9712b2edf1fc624099cf2bbf61832e8ea6ace435ca4e6
Exact accepted details: {"rows":1,"eof":false,"skipIdxUntil":7,"stepConflict":"conflict-token","notifications":["notice-a","notice-b"]}
Malformed controls rejected atomically: non-boolean eof; negative/fractional skipIdxUntil; empty stepConflict; non-array notifications
```

**Adversarial required-row-field probe**: ❌ Failed against current code

```text
Command: inline Node probe using harness/mock_tasker.js and Compiler.js
Exit: 1
Output hash: sha256:66408b7a6a03e8d5a36b8661310e40b7a2717b33354deafeecddff448b951503
Observed: missing_evLoc accepted=true rejected=false published=true
```

The probe removed the required `evLoc` property from an otherwise valid typed row. Compiler emitted `TYPED_QUEUE_ACCEPTED`, did not emit `TYPED_QUEUE_REJECTED`, and published a generation. This violates the required row contract and atomic invalid-row rejection.

**LOG-17 runtime probe**: ✅ 5/5 emitted Slice A event codes carried all fields

```text
Command: inline Node probe using harness/mock_tasker.js and Compiler.js
Exit: 0
Output hash: sha256:bbc80ba8aa07573211385daf70d8adb761e0d979876f631ea766b575c85670ac
Codes: TYPED_QUEUE_ACCEPTED, TYPED_QUEUE_CUTOVER_COMPLETED, DEPARTURE_POLICY_FALLBACK_USED, TYPED_QUEUE_REJECTED, ZERO_DURATION_LEG_REJECTED
Fields: timestamp, generationId, component, severity, code, tripId, details
```

**FORCED_DRIVE runtime probe**: ✅ Passed

```text
Command: inline Node late-event/exact-preference DRIVE Sandbox probe
Exit: 0
Output hash: sha256:db3107877414903b8abfc0eb12d86b1193a80377f9884f6aaa808c2c81c948f0
Result: FORCED_DRIVE emitted as a homogeneous 21-field typed object row with mode DRIVE and departurePolicy ASAP.
```

**Static cutover inspection**: ✅ Passed

- Production `Sandbox_Engine.js` has one queue push: `queue.push(typed)`.
- No string-literal pipe row is pushed in production Sandbox or Compiler.
- No executable `block_step17`-`block_step21` producer/consumer exists; the two remaining matches in Compiler are comments.
- `TYPED_QUEUE_CUTOVER_COMPLETED` is emitted after the typed compile loop.

**Coverage**: ➖ Not available; this Tasker project has no coverage runner.

### Spec Compliance Matrix

| Requirement | Scenario | Runtime evidence | Result |
|---|---|---|---|
| REQ-5QUEUE-1 | SCN-5QUEUE-1 — valid envelope and exact control retention (`TYPED_QUEUE_ACCEPTED`) | Distinctive non-default controls were retained byte-for-value in accepted details; all four malformed control classes rejected atomically. | ✅ COMPLIANT |
| REQ-5QUEUE-1 | SCN-5QUEUE-2 — malformed/schema/invalid-row rejection (`TYPED_QUEUE_REJECTED`) | Committed harness passed malformed JSON, unsupported schema, invalid policy, and invalid-second-row atomic rejection. Independent probe removed required `evLoc`; Compiler accepted and published it. | ❌ FAILING |
| REQ-5CUTOVER-1 | SCN-5CUTOVER-1 — shadow divergence blocks typed authority | Transition-only scenario. Cutover is complete and the shadow mechanism is intentionally absent at current HEAD; it cannot fire post-cutover and is not counted as current runtime compliance. | ➖ NOT APPLICABLE POST-CUTOVER |
| REQ-5CUTOVER-1 | SCN-5CUTOVER-2 — cutover retires steps 17-21 (`TYPED_QUEUE_CUTOVER_COMPLETED`) | Focused runtime emitted the event; source/AST inspection found no executable producer/consumer and only `queue.push(typed)`. | ✅ COMPLIANT |
| REQ-5CUTOVER-1 | SCN-5CUTOVER-3 — reject zero-duration travel | Focused runtime consumed positive typed tier-2 metrics and separately rejected unavailable/nonpositive metrics without publishing a leg. | ✅ COMPLIANT |
| REQ-5LOG-1 | SCN-5LOG-1 — LOG-17 fields and Phase 5 event code | Independent runtime probe found all seven required fields on all five emitted post-cutover Slice A codes. | ✅ COMPLIANT |

**Compliance summary**: 4/6 scenarios compliant; 1 failing; 1 transition-only/not applicable after completed cutover. Top-level requirements: 2/3 compliant.

### Run-5 Verdicts (post `4543e30` evLoc fix)

| Requested dimension | Verdict | Current evidence |
|---|---|---|
| REQ-5QUEUE-1 / SCN-5QUEUE-1 | ✅ PASS | All four controls validate; distinctive values survive exactly in `TYPED_QUEUE_ACCEPTED`. |
| REQ-5QUEUE-2 / SCN-5QUEUE-2 | ✅ PASS | `isValidTypedRow` now requires all 21 spec fields including `evLoc`; missing/wrong-typed fields reject atomically with `TYPED_QUEUE_REJECTED` and nothing compiles or publishes. Regression committed (`missing evLoc`). |
| REQ-5CUTOVER-1 / SCN-5CUTOVER-1 | ➖ N/A post-cutover | Shadow divergence is a completed transition condition and has no current executable shadow path. |
| REQ-5CUTOVER-2 / SCN-5CUTOVER-2 | ✅ PASS | Cutover event emitted; steps 17-21 and string-literal pipe rows are retired. |
| REQ-5CUTOVER-3 / SCN-5CUTOVER-3 | ✅ PASS | Tier-2 typed metrics passed; unavailable/nonpositive metrics rejected without publication. |
| REQ-5LOG-1 / SCN-5LOG-1 | ✅ PASS | Five emitted post-cutover codes passed all LOG-17 fields at runtime. |

### Correctness (Static Evidence — run 5)

| Requirement | Status | Notes |
|---|---|---|
| REQ-5QUEUE-1 | ✅ Complete | `parseQueueEnvelope` validates all four controls and all 21 row fields (including `evLoc`) before compilation. |
| REQ-5CUTOVER-1 | ✅ Implemented post-cutover | Typed rows are authoritative; `queue.push(typed)` is the sole production queue push; no executable step 17-21 path remains. INV-0.7 order is API → positive typed metrics → supported ACTIVE_TRAVEL estimate → reject. |
| REQ-5LOG-1 | ✅ Implemented | Runtime proved all seven LOG-17 fields for all five emitted Slice A post-cutover codes. |

### Coherence (Design — run 5)

| Decision | Followed? | Notes |
|---|---|---|
| Parse and validate the complete envelope once before compiling rows | ✅ Yes | One parse; complete control + row-schema validation (all 21 fields incl. `evLoc`). |
| Retain exact envelope control values | ✅ Yes | Independent runtime proved exact `eof`, `skipIdxUntil`, `stepConflict`, and notification values. |
| Typed row fields become authoritative after cutover | ✅ Yes | Runtime and static evidence prove typed metrics/policy/day/origin authority. |
| Remove every executable step 17-21 producer/consumer | ✅ Yes | Only comment references remain in Compiler. |
| Homogeneous typed queue, including FORCED_DRIVE | ✅ Yes | Runtime emitted a complete 21-field `FORCED_DRIVE` object; Sandbox has only `queue.push(typed)`. |
| Reject unsupported zero-duration travel | ✅ Yes | Runtime rejected and published no leg. |
| Standalone Tasker JSlets; no dependencies/promises/timers | ✅ Yes | No unsupported runtime construct or dependency was introduced. |

### Issues Found (run 5)

**CRITICAL**

None. The run-4 `evLoc` defect was fixed in `4543e30`; the missing-field regression is committed and passes.

**WARNING**

1. The full change has 9 unchecked Slice B-D tasks. They do not block this scoped PR-A assessment, but they prohibit final full-change verification and archive.

**SUGGESTION**

1. Add a committed regression that deletes each required row property one at a time and proves atomic rejection/no publication; the current harness only exercises an invalid `departurePolicy` as its row-schema rejection case.
2. Commit the distinctive non-default control-retention assertion used by this verification; `test_typed_queue.js:274-277` still asserts only row count and `eof`, although current production code now preserves all controls exactly.

The branch size is 1,085 changed lines (`784` additions, `301` deletions). It is recorded but not treated as a new blocker because the maintainer previously accepted the Slice A size exception.

### Canonical Verification Evidence Preimage

The following exact bytes hash to `sha256:addba56ae4729fc3b8432f51f759ed5b5ac5c816519cf357be948d9ab512f0ff`:

```text
schema=gentle-ai.verification-evidence/v1
change=tasker-tesla-upgrade-phase-5-typed-protocols
slice=Slice A (PR-A)
run=4
branch=tasker-tesla-phase5-pr-a
head=422f9601b10ef1b45b2a29381d3418e630700e8d
focused_command=for t in harness/test_typed_queue.js harness/test_ac3_sandbox.js harness/test_ac5.js harness/test_atomic_publication.js harness/test_compiler_ac1.js harness/test_compiler_ac8.js harness/test_dst_utc.js harness/test_id_parsing.js harness/test_manual_session.js harness/test_sandbox_ac6.js harness/test_sandbox_ovr10.js harness/test_single_writer.js; do node "$t" || exit 1; done
focused_exit_code=0
focused_scripts=12/12
focused_output_hash=sha256:74d45e4a89f900ed0f1084185c04a9abdfd8623fb937f6814f6516fba10a115e
full_command=for t in harness/test_*.js; do node "$t" || exit 1; done
full_exit_code=0
full_scripts=25/25
full_output_hash=sha256:93b5a5e37b8c70deb8e0709c4b183d0cc493450d17a31065d63837fc5267e97c
build_command=for f in *.js harness/*.js; do node --check "$f" || exit 1; done
build_exit_code=0
build_files=50/50
build_output_hash=sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
adversarial_control_probe=inline Node Compiler exact-control retention and malformed-control atomic rejection
adversarial_control_exit_code=0
adversarial_control_output_hash=sha256:a011b4f49dcb575c61a9712b2edf1fc624099cf2bbf61832e8ea6ace435ca4e6
adversarial_required_row_probe=inline Node Compiler missing-evLoc atomic rejection
adversarial_required_row_exit_code=1
adversarial_required_row_output_hash=sha256:66408b7a6a03e8d5a36b8661310e40b7a2717b33354deafeecddff448b951503
adversarial_required_row_observation=missing_evLoc accepted=true rejected=false published=true
log17_probe=inline Node five emitted Slice A event codes
log17_exit_code=0
log17_output_hash=sha256:bbc80ba8aa07573211385daf70d8adb761e0d979876f631ea766b575c85670ac
forced_drive_runtime_probe=inline Node late-event exact-preference DRIVE path
forced_drive_runtime_exit_code=0
forced_drive_runtime_output_hash=sha256:db3107877414903b8abfc0eb12d86b1193a80377f9884f6aaa808c2c81c948f0
static_block_step17_21_executable_matches=0
static_queue_push_string_literal_matches=0
static_sandbox_queue_pushes=1:queue.push(typed)
finding=Compiler validates all four envelope controls and retains their exact values, but isValidTypedRow omits the required evLoc field, so a malformed row is accepted and published rather than atomically rejected.
```

### Files Reviewed

- `openspec/changes/tasker-tesla-upgrade-phase-5-typed-protocols/proposal.md`
- `openspec/changes/tasker-tesla-upgrade-phase-5-typed-protocols/specs/itinerary/spec.md`
- `openspec/changes/tasker-tesla-upgrade-phase-5-typed-protocols/design.md`
- `openspec/changes/tasker-tesla-upgrade-phase-5-typed-protocols/tasks.md`
- `openspec/changes/tasker-tesla-upgrade-phase-5-typed-protocols/verify-report.md` (run 3 baseline)
- `Compiler.js`
- `Sandbox_Engine.js`
- `harness/mock_tasker.js`
- `harness/runner.js`
- `harness/test_typed_queue.js`
- All 11 additional migrated Slice A harnesses listed in focused execution
- Commits `993f676`, `066a9e6`, `bceb752`, `08725ca`, and `422f960`

### Verdict

**FAIL**

Commit `422f960` fixes the run-3 control defect: all controls validate, malformed controls reject atomically, and accepted evidence retains exact values. Slice A is still blocked because Compiler accepts and publishes a typed row that omits required `evLoc`, violating REQ-5QUEUE-1 / SCN-5QUEUE-2. Resolve the row-schema validator and add comprehensive missing-field regressions before Slice B.
