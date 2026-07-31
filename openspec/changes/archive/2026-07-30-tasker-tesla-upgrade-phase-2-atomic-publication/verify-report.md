```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:d02621653eb48a06cb253e297ec22df2c7482290bc88a11586fec2bfa2f57172
verdict: fail
blockers: 10
critical_findings: 10
requirements: 2/12
scenarios: 14/30
test_command: 'node harness/test_atomic_publication.js && node harness/test_compiler_ac1.js && node harness/test_compiler_ac8.js && node harness/test_dispatcher_ac10.js && node harness/test_dispatcher_ac9.js && node harness/test_dispatcher_overdue_wins.js && node harness/test_dispatcher_relevance.js && node harness/test_dst_utc.js && node harness/test_sandbox_ac6.js'
test_exit_code: 0
test_output_hash: sha256:b813916119f7d55d5f935f50310ba3ab44cbfaf59432fbb872b6e4cadd514e5e
build_command: 'node --check Generation_Publisher.js'
build_exit_code: 0
build_output_hash: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

# Verify Report: Phase 2 — Atomic Publication

## Status
failed

**Change:** `tasker-tesla-upgrade-phase-2-atomic-publication`  
**Mode:** Standard (Strict TDD inactive)  
**Repository revision:** `37798706167b5a02cad4b904ebb6d133fb51e180`

## Test surface

- Tests run: 9 harness files, executed under Node's VM sandbox.
- Pass / Fail: 9 / 0.
- Coverage: not available; this project has no coverage tool.
- Build: not available; this Tasker project has no build, linter, type checker, or formatter.
- Supplemental runtime probes: four probes exposed spec violations despite the green harness: an invalid zero-duration candidate committed, a `building` manifest exposed candidate data, a retained generation ID was reused, and a failed candidate lost its generation ID.

### Per-test summary

- `test_atomic_publication.js` — PASS
- `test_compiler_ac1.js` — PASS
- `test_compiler_ac8.js` — PASS
- `test_dispatcher_ac10.js` — PASS
- `test_dispatcher_ac9.js` — PASS
- `test_dispatcher_overdue_wins.js` — PASS
- `test_dispatcher_relevance.js` — PASS
- `test_dst_utc.js` — PASS
- `test_sandbox_ac6.js` — PASS

## Spec coverage

- ADDED Requirements: 10 of 10 have at least one related harness assertion; only 2 of 10 are fully compliant across all scenarios and implementation evidence.
- MODIFIED Requirements: 2 of 2 have related assertions; 0 of 2 are compliant (`PUB-7` and `OWN-8` both have blocking contradictions).
- REMOVED Requirements: 0 of 0.
- Canonical merge state: the two modified requirements are not yet reflected in `openspec/specs/itinerary/spec.md`; this is normally performed by archive, but archive is blocked by this report.
- Requirements with no test at all: none.
- Scenarios without a complete passing runtime test: 16 of 30 (5 UNTESTED, 9 PARTIAL, 2 FAILING).

### Behavioral compliance matrix

| Requirement | Scenario | Runtime evidence | Result |
|---|---|---|---|
| Generation ID Format | Collision avoidance | `test_atomic_publication.js:testId` | ✅ COMPLIANT for active/previous collision |
| Generation ID Format | Parsing | Regex-only assertion; no parse-result assertion | ❌ UNTESTED |
| Generation Lifecycle States | Build begins | No observable/asserted `building` state | ❌ UNTESTED |
| Generation Lifecycle States | Successful transition | `testPublish` | ✅ COMPLIANT |
| Generation Lifecycle States | Failed transition | Failure asserted, but failed candidate identity and terminality are not | ⚠️ PARTIAL |
| TDS Run Manifest Schema | First publication | Counts/state asserted; `previousGeneration === null` is not | ⚠️ PARTIAL |
| TDS Run Manifest Schema | Superseding publication | Retention loop commits repeatedly but never asserts active/previous linkage | ❌ UNTESTED |
| TDS Run Manifest Schema | Failed publication | Prior active asserted; previous/state/candidate identity are not | ⚠️ PARTIAL |
| Versioned File Naming | Colon-safe encoding | `testManifestLastWriteOrder` | ✅ COMPLIANT |
| Manifest-Last Publication Order | Successful order | `testManifestLastWriteOrder` | ✅ COMPLIANT |
| Manifest-Last Publication Order | Events write fails | Error/prior asserted; stop-after-failure order is not | ⚠️ PARTIAL |
| Manifest-Last Publication Order | Master write fails | Error/prior asserted; later-write absence is not | ⚠️ PARTIAL |
| Manifest-Last Publication Order | Itinerary write fails | Error/prior asserted; commit-manifest absence is not | ⚠️ PARTIAL |
| Manifest-Last Publication Order | Manifest write fails | Prior remains active; candidate failed state is not asserted | ⚠️ PARTIAL |
| Committed Generation Discovery | Active generation | `testResolver`, `testEndToEndFlow` | ✅ COMPLIANT for a committed fixture |
| Committed Generation Discovery | Prior fallback | `testResolver`, `testReaderFallback` | ✅ COMPLIANT for non-committed/corrupt active fixtures |
| Committed Generation Discovery | Empty fallback | `testEmptyFallback` | ✅ COMPLIANT |
| Generation ID Propagation | Commit | Global checked; the promised 15-site inventory is not exercised | ⚠️ PARTIAL |
| Generation ID Propagation | Failure | `testPublish`, `testFailures`, `testReadBackRejectsTornWrite` | ✅ COMPLIANT |
| Generation ID Propagation | Restart | Fresh-process empty global is not asserted | ❌ UNTESTED |
| RULE-8A Remediation | Gatekeeper write removal | `testGatekeeperEmitsCommand`, static source assertion | ✅ COMPLIANT |
| RULE-8A Remediation | API Parser write removal | `testApiParserEmitsCommand`, static source assertion | ✅ COMPLIANT |
| RULE-8A Remediation | Alpha clear removal | `testRule8aOwnership` | ✅ COMPLIANT |
| Generation Retention | Normal retention | `testRetention`, `testPruneDeletesOldGenerations` | ✅ COMPLIANT |
| Generation Retention | Rapid commits | Six same-second commits in `testRetention` | ✅ COMPLIANT |
| Generation Retention | First commit | Implicitly exercised; no explicit no-prune assertion | ⚠️ PARTIAL |
| Legacy Master Migration | First migration | `testMigration` | ✅ COMPLIANT |
| Legacy Master Migration | Rollback | Backups exist, but restoration/disable ordering is neither implemented nor executed | ❌ UNTESTED |
| PUB-7 | No partial generation becomes active | Finaliser activates an event-only generation before Compiler; readers also accept non-committed active data | ❌ FAILING |
| OWN-8 | Unauthorized write | `Depart_Now.js` and `Return_to_Base.js` directly write `Itin_Master.json` | ❌ FAILING |

**Compliance summary:** 14/30 scenarios compliant; 9 partial; 5 untested; 2 failing.

### Correctness (static and runtime evidence)

| Requirement | Status | Evidence |
|---|---|---|
| Generation ID Format | ❌ | `Generation_Publisher.js:131-139` ignores `generationHistory` and retained files; probe reused a retained ID. |
| Generation Lifecycle States | ❌ | `Generation_Publisher.js:167,183-188` loses `genId` in the catch path and writes a failed manifest with `generationId: null`. |
| TDS Run Manifest Schema | ⚠️ | Success counts are correct, but failed-candidate identity/path fields are lost. |
| Versioned File Naming | ✅ | `Generation_Publisher.js:15-18` encodes colons as underscores. |
| Manifest-Last Publication Order | ⚠️ | Resource order is correct, but required validation is absent and Finaliser activates before the complete generation exists. |
| Committed Generation Discovery | ❌ | Resolver copies do not require `state === "committed"`; a probe read candidate data from a `building` manifest. |
| Generation ID Propagation | ⚠️ | Commit/failure global behavior works, but the claimed 15-site coverage is not present. |
| RULE-8A Remediation | ⚠️ | Named Gatekeeper/API/Alpha writes were removed, but manual entry points still write the legacy itinerary directly. |
| Generation Retention | ⚠️ | Pruning works, but retained IDs are not included in collision detection. |
| Legacy Master Migration | ❌ | Backups exist, but readers were not cut over together and rollback restoration is untested. |
| PUB-7 | ❌ | Partial generation activation, missing validation, and non-committed reads contradict the requirement. |
| OWN-8 | ❌ | Unauthorized itinerary and override writers remain. |

## Task closure

- Checkbox state: 13 of 13 task sections present in `tasks.md` are checked.
- Independently verified complete: tasks 1, 5, 7, 18, and 19.
- Materially incomplete or contradicted: tasks 2, 3, 4, 6, 8, 9, 10, and 20.
- Requested 1–21 ledger: only 13 numbered sections exist (1–10, 18–20); IDs 11–17 and 21 are absent, so a 21-task audit is impossible from the authoritative artifact.
- Deferred: none explicitly marked in the final task file.
- Missing: task 4's validation gates; task 6's committed-state enforcement; task 8's exhaustive 15-site proof; task 9's all-reader cutover; task 10's full scenario verification; task 20's single complete-generation end-to-end behavior.

## AGENTS.md compliance

- Single-writer contract: **FAIL** — versioned resources are Publisher-owned, but `Depart_Now.js:34` and `Return_to_Base.js:82` write `Itin_Master.json`; non-Override-Handler scripts also write `TDS_Overrides.json`.
- No direct writes from the specifically named Phase 2 entry points (`Alpha`, `Finaliser`, `Compiler`, `Gatekeeper`, `API_Parser`, `Dashboard`, `Dispatcher`, `Sandbox_Engine`) to masters: **PASS** for direct master writes.
- No Alpha.js master clears: **PASS** — no live `writeFile(..., "[]", false)` master clear remains; only archived baseline copies match.
- No production `generationId: null` literal: **PASS** for the requested literal search; the only literal is a test reorder fixture. The Publisher can still emit null dynamically on failure.
- 15 placeholders emit global: **FAIL** — live source has only six direct structured `generationId: global('TDS_Active_Generation') || null` fields, and the harness checks only a subset. The 15-site claim is not proven.
- No zero-duration published leg: **FAIL** at the Publisher boundary; the supplemental probe committed `durationSecs: 0`.
- Local-day chain boundary: **FAIL** — `Generation_Publisher.js:30-35,68` and `Dispatcher.js:204` use UTC calendar-day comparison instead of configured local planning day.
- Occurrence ID parsing: **FAIL** — `Appender.js:90`, `Sandbox_Engine.js:995`, and `Override_Injector.js:100` use `split("_")[0]`.
- Exact-key event membership: **FAIL** — `Appender.js:58-60` removes override entries using substring matching.
- Other Phase 0 safety checks: route-duration fallback, stop-padding once, live-base precedence, stale selection, and idle-sync harness tests pass. No Node timers, Promises, or new dependencies were found.

## End-to-end behaviour

- Alpha → Publisher → readers flow tested: **yes, but invalidly split into two commits**. `test_atomic_publication.js:639-643` expects Finaliser to commit, then lines 669-674 expect Compiler to commit again. This does not prove one indivisible complete generation.
- Mock supports delete: **yes** — `harness/mock_tasker.js:90-94`.
- Mock supports write-order: **yes** — `harness/mock_tasker.js:48,82-89,149`.
- Mock supports torn-write read-back: **yes** — `harness/mock_tasker.js:50-52,82-86`; asserted by `testReadBackRejectsTornWrite`.
- Manifest-last order asserted: **yes** — `testManifestLastWriteOrder`.
- Retention pruning asserted: **yes** — `testPruneDeletesOldGenerations`.
- Generation ID propagation asserted: **partially** — commit/global plus four structured log paths, not the claimed 15-site inventory.
- Reorder consumed before master write: **yes** — `Generation_Publisher.js:175-177`, asserted by `testReorderTiming`.

## Design coherence

| Decision | Followed? | Notes |
|---|---|---|
| Dedicated Publisher | ⚠️ Partial | Module exists, but Finaliser publishes before Compiler instead of staging through one final boundary. |
| Finaliser validates / Compiler assembles / Publisher commits | ❌ No | Finaliser itself triggers a commit with the legacy itinerary. |
| Private manifest writer | ✅ Yes | Manifest writes are confined to Publisher. |
| Shared read-only resolver | ❌ No | Resolver logic is duplicated in multiple scripts and each copy ignores manifest state. |
| Serialized reorder command | ⚠️ Partial | Applied before master write, but implemented as a multi-writer file queue and validated by UTC day. |
| Canonical identity and encoding | ⚠️ Partial | Format/encoding work; retained collision detection does not. |
| `building → committed|failed`, manifest-last/read-back | ❌ No | Building is not represented, failed identity is lost, and readers accept non-committed active data. |
| Retention and active global | ⚠️ Partial | Basic behavior works; exhaustive log propagation is not proven. |
| Events fork, backups, one-shot reader cutover | ❌ No | Events/backups exist; reader cutover is incomplete. |

## CRITICAL findings

1. **A partial generation becomes active before compilation.** `Finaliser.js:168-172` publishes `validEvents` with the current legacy itinerary, and Compiler later publishes a second generation. The end-to-end test explicitly expects both commits (`harness/test_atomic_publication.js:639-674`). This contradicts PUB-7's indivisible generation and the design flow. **Suggested fix:** Finaliser must only stage validated events; invoke Publisher exactly once after Compiler assembles all three candidates.
2. **The Publisher does not perform the required validation gates.** `Generation_Publisher.js:163-166` checks only that three values are arrays, then publishes them at lines 171-179. A runtime probe committed an itinerary containing `durationSecs: 0` and no required policy/day/completion fields. **Suggested fix:** validate event/leg schemas, generation identity, departure policy, planning day/chains, positive route duration, completion policy, and counts before the first write; add negative runtime tests.
3. **Readers consume non-committed active generations.** `TDS_Helper.js:18-28` and copies in Compiler, Dispatcher, Dashboard, and Sandbox check `activeGeneration` but not `state === "committed"`. A runtime probe returned candidate data from a `building` manifest. **Suggested fix:** reject all non-committed active data and fall back only to a verified prior generation or empty state.
4. **The all-reader cutover is incomplete.** Finaliser still reads `Itin_Master.json` (`Finaliser.js:168,198`); Gatekeeper and API Parser read `TDS_Master.json` (`Gatekeeper.js:57`, `API_Parser.js:37`); Override Injector reads legacy itinerary (`Override_Injector.js:16`); manual actions also use legacy itinerary. These paths can act on stale/non-authoritative data after manifest switch. **Suggested fix:** route every reader through one committed manifest resolver and remove legacy reads after the migration gate.
5. **Manual entry points bypass RULE-8A.** `Depart_Now.js:8,34` and `Return_to_Base.js:57,82` directly rewrite `Itin_Master.json`, contrary to AGENTS.md and OWN-8 command-adapter rules. Because manifest readers ignore that file after cutover, these actions can also become ineffective. **Suggested fix:** emit typed manual-action commands and leave itinerary publication solely to the Publisher.
6. **Generation collision detection ignores retained generations.** `Generation_Publisher.js:131-139` checks only manifest `generationId`, active, and previous, not `generationHistory` or existing resource paths. A runtime probe reused `gen:1700000000:ab12` while it remained retained. **Suggested fix:** reject IDs present anywhere in retained history/resources and test collisions against all five retained generations.
7. **Failed candidates lose their identity.** `genId` is block-scoped inside the try (`Generation_Publisher.js:167`); the catch writes `manifest(null, ...)` and logs null (`:183-188`). The failed generation therefore never reaches the required terminal state under its own ID. **Suggested fix:** retain the minted ID outside the try and bind failed state/log evidence to it without promoting it.
8. **Day-boundary validation uses UTC rather than configured local planning day.** `Generation_Publisher.js:30-35,68` and `Dispatcher.js:204` compare UTC dates; `test_dst_utc.js` reinforces that behavior. This contradicts the local, timezone-configured, DST-safe hard rule. **Suggested fix:** compare explicit `planningDay` values derived from the configured timezone and replace the UTC-centric test with local-midnight/DST cases.
9. **Additional AGENTS.md hard-rule violations remain.** Occurrence IDs are parsed with `split("_")[0]` in `Appender.js:90`, `Sandbox_Engine.js:995`, and `Override_Injector.js:100`; `Appender.js:58-60` uses substring membership; and `Compiler.js:463`, `Finaliser.js:127`, `Override_Injector.js:142`, `Appender.js:133`, and `Stop_Logger.js:43` bypass the Override Handler's single-writer ownership. **Suggested fix:** use `lastIndexOf("_")`, exact-key maps, and command adapters to the assigned writer.
10. **Runtime scenario coverage is insufficient for final verification.** Of 30 authoritative scenarios, only 14 are fully covered; 5 are untested, 9 partial, and 2 fail. Missing proof includes parsing, building state, superseding linkage, restart-global behavior, rollback restoration, failure stop-order, and the promised 15-site propagation inventory. **Suggested fix:** add scenario-level tests that fail on the defects above; do not rely on the single aggregate PASS line.

## WARNING findings

1. **The task ledger is structurally inconsistent.** `tasks.md` contains 13 sections numbered 1–10 and 18–20, while the verification request identifies tasks 1–21. IDs 11–17 and 21 have no auditable text. **Suggested fix:** restore a contiguous authoritative task ledger or explicitly document removed/renumbered tasks.
2. **The canonical specification has not yet absorbed the delta.** `openspec/specs/itinerary/spec.md` still contains the pre-delta PUB-7/OWN-8 text and lacks the ten additions. This is normally archive work, but it means the requested replacement check is currently 0/2. **Suggested fix:** sync only after blockers are fixed and verification passes.
3. **The VM harness masks device integration assumptions.** `harness/mock_tasker.js:55-58,119-140` injects a callable `publish()` and `deleteFile()` directly into each sandbox. Production scripts only stage `%par1` when Tasker does not expose `publish`, and no device/task-configuration execution proves the Publisher action or deletion primitive is sequenced correctly. **Suggested fix:** add a Tasker task-configuration contract/device smoke test for staging → Publisher invocation and retention deletion.

## SUGGESTION findings

1. Centralize manifest resolution in one shared Tasker action/helper instead of maintaining five divergent copies; this would have prevented the missing committed-state check.
2. Replace regex checks limited to direct string literals with a complete live-script writer/reader inventory that resolves variable-backed paths and excludes `_archive/` explicitly.

## Memory-worthy discoveries

- A green nine-file harness does not imply PUB-7 compliance: Finaliser and Compiler currently create two committed generations for one planning flow.
- All resolver copies trust `activeGeneration` without requiring a committed manifest state.
- Retention history is not part of generation-ID collision detection, so a retained generation can be overwritten.
- Legacy manual actions still rewrite `Itin_Master.json`, which is both a RULE-8A violation and ineffective once readers follow the manifest.

## Verdict

**FAIL**

Archive is blocked. The implementation passes all current harness files but contradicts atomic publication, committed-only discovery, required Publisher validation, lifecycle identity, reader cutover, and single-writer rules.
