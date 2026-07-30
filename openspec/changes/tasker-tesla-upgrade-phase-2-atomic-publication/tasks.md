# Tasks: Phase 2 — Atomic Publication

## 1. Publisher skeleton
**Files:** `Generation_Publisher.js`  
**Spec requirements:** PUB-7, OWN-8. **Estimate:** ~35 lines. **Depends on:** none.  
**Change:** [x] Add stub `publish(candidate)`, `prune()`, and `migrateFromLegacy()`; establish the sole commit boundary.  
**Acceptance:** APIs exist without publishing partial data. **Verification:** harness loads the module.

## 2. Identity and manifest primitives
**Files:** `Generation_Publisher.js`  
**Spec requirements:** Generation ID, lifecycle, schema, naming. **Estimate:** ~90 lines. **Depends on:** 1.  
**Change:** [x] Mint `gen:<10-digit>:<4hex>` with collision retry; encode `:` as `_`; build the 11-field manifest and in-memory `building` state; use last-write and read-back confirmation.  
**Acceptance:** IDs, paths, counts, and states match the delta. **Verification:** ID collision/parse/encoding and schema tests.

## 3. RED: publication failure/order tests
**Files:** `harness/mock_tasker.js`, `harness/test_atomic_publication.js`  
**Spec requirements:** PUB-7, VAL-18. **Estimate:** ~130 lines. **Depends on:** 1.  
**Change:** [x] Add injected write/read failures, delete, and write-order capture; add failing tests for each resource failure, manifest-last, read-back mismatch, and prior-pointer preservation.  
**Acceptance:** tests fail against stubs and cover all design §7 scenarios. **Verification:** `node harness/test_atomic_publication.js` (RED first).

## 4. PUBLISH implementation
**Files:** `Generation_Publisher.js`  
**Spec requirements:** PUB-7, OWN-8, LOG-17. **Estimate:** ~180 lines. **Depends on:** 2,3.  
**Change:** [x] Validate candidate schemas/policy/days/chains/durations/completion; write/read back events → master → itinerary → committed manifest; apply queued reorder snapshots; fail safely, log `GENERATION_VALIDATION_FAILED`, clear global, and recover prior manifest.  
**Acceptance:** no candidate becomes active before manifest success. **Verification:** GREEN failure/order/read-back tests.

## 5. Migration and retention
**Files:** `Generation_Publisher.js`  
**Spec requirements:** Legacy migration, retention. **Estimate:** ~70 lines. **Depends on:** 4.  
**Change:** [x] Validate legacy masters, create `.legacy.json` backups, version-publish first generation; prune post-commit with `PHASE2_RETENTION = 5` using Tasker delete.  
**Acceptance:** rollback data survives and failed commits never prune. **Verification:** migration, rollback, first/fifth/sixth-commit tests.

## 6. Read-only resolver and global
**Files:** `TDS_Helper.js`, `Generation_Publisher.js`  
**Spec requirements:** Discovery, propagation, OWN-8. **Estimate:** ~75 lines. **Depends on:** 2,4.  
**Change:** [x] Add `readActiveGeneration(kind)` for committed active → prior → empty fallback; make the former generic setter throw; set `TDS_Active_Generation` only after commit and clear on failure/restart.  
**Acceptance:** exact manifest paths are used. **Verification:** active/prior/empty and global success/failure tests.

## 7. Remove unauthorized writers and stage
**Files:** `Gatekeeper.js`, `API_Parser.js`, `Alpha.js`, `Compiler.js`, `Finaliser.js`  
**Spec requirements:** RULE-8A, CLUSTER-12, SCRIPT-15. **Estimate:** ~110 lines. **Depends on:** 4,6.  
**Change:** [x] Compiler/Finaliser stage candidates and hand off publication (PR-B). Gatekeeper:56 and API_Parser:33 `APPLY_CLUSTER_REORDER` + Alpha:392–393 clear removal deferred to PR-C.  
**Acceptance:** only Publisher writes versioned resources. **Verification:** ownership/order assertions and reorder timing test.

## 8. Replace all 15 placeholders
**Files:** `Compiler.js`, `API_Parser.js`, `Sandbox_Engine.js`, `ID_Parser.js`, `Dispatcher.js`, `Override_Handler.js`  
**Spec requirements:** Generation ID Propagation, LOG-17. **Estimate:** ~30 lines. **Depends on:** 6.  
**Change:** [x] Replace `generationId: null` at Compiler:50; API Parser:99,139; Sandbox:281,462,533,1027,1041,1361; ID Parser:37; Dispatcher:123,139,156,348; Override Handler:36 with `global('TDS_Active_Generation')`.  
**Acceptance:** all 15 logs carry the active ID. **Verification:** placeholder inventory test.

## 9. Cut over readers
**Files:** `Dispatcher.js`, `Dashboard.js`, `Sandbox_Engine.js`  
**Spec requirements:** Discovery, PUB-7, SCRIPT-15. **Estimate:** ~75 lines. **Depends on:** 6,7.  
**Change:** [x] Read manifest-declared resources through `TDS_Helper` in Dispatcher, Dashboard, and Sandbox_Engine; use empty fallback, and Dispatcher idle sync when no readable generation.  
**Acceptance:** no legacy direct read remains in these paths. **Verification:** reader cutover and idle-fallback tests.

## 10. Full verification
**Files:** `harness/test_atomic_publication.js`  
**Spec requirements:** VAL-18, DOD-19. **Estimate:** ~80 lines. **Depends on:** 3–9.  
**Change:** [x] PR-A partial: cover lifecycle, schema/counts, all write failures, fallback, retention, and migration in `harness/test_atomic_publication.js`. Remaining: 15 IDs, ownership, reorder, rollback, no-partial activation, full harness (PR-D).  
**Acceptance:** `node harness/test_atomic_publication.js` and every existing harness test pass.

## Review Workload Forecast

- **Total estimated changed lines:** 845
- **Number of files touched:** 14
- **Chained PRs recommended:** Yes
- **400-line budget risk:** High
- **Decision needed before apply:** Yes

The Publisher and harness are the dominant units; staged reader cutover depends on their contract. Out of scope: append-only audit, trip-state migration, typed protocols, Alpha decomposition, and atomic rename. Threat-matrix documentation/Git/commit/push/PR rows are N/A; Tasker sequencing is covered above.
