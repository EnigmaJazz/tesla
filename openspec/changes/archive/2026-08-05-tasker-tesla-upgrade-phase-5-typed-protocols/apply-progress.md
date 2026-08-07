# Apply Progress — Phase 5 Remediation (R1, R2)

**Change**: tasker-tesla-upgrade-phase-5-typed-protocols (re-opened by `dff4f08`)
**Round**: Remediation R1–R3 (run-2 whole-change FAIL: direct readers accept invalid cache entries)
**Mode**: Standard (RED→GREEN work units mandated by the remediation contract)
**Scope**: REQ-5CACHE-2 SCN-5CACHE-3 + REQ-5LOG-1 SCN-5LOG-1 at the reader
**Bounded attempt**: acquired (token sha256:3d2f79fb5f50f8b200bb3cb839dcd101f3e4a9e5a9879927f3335d0b8b078fa1)

## Task status

- [x] R1 RED — adversarial reader regression (committed `dad2243`; proven FAIL on base `7f7bced`, exit 1)
- [x] R2 GREEN — reader validation + LOG-17 (committed `573f573`; R1 passes with reader-origin logs)
- [ ] R3 VERIFY — left to the verify phase

## Work Unit Evidence

| Evidence | Required value |
|---|---|
| Focused test command and exact result | `node harness/test_cache_readers.js` → exit 0, `PASS: Cache Readers — ... TTL reader contract` (includes the new reader-rejection sections (f)); RED proof: same file on base tree exits 1 (`cache_hit=true` for zero-duration, 0 reader-origin logs) |
| Runtime harness command/scenario and exact result | `for t in harness/test_*.js; do node "$t" || exit 1; done` → exit 0, 28/28 scripts, 37 PASS lines, no FAIL; `node --check` on 54/54 `*.js` files → exit 0 |
| Rollback boundary | Revert `dad2243`+`573f573` together (or the docs commit alone) → restores the pre-remediation readers; production edits are isolated to `Gatekeeper.js readCacheJson` and `Sandbox_Engine.js sbReadCacheJson` (plus 3 realistic-key fixture lines in `harness/test_cache_readers.js`) and remove nothing else |

## Verification (final state)

- Focused: `node harness/test_cache_readers.js` exit 0; output hash `sha256:47270f1677b48e21d326a457b855e72bf9c70a9cfc5aeb3f43559992871d7569`
- Full suite: exit 0, 28/28 (byte-identical output to the run-2 28/28 baseline); output hash `sha256:ddd91e380fb0774286101762af46264615da9259c154ac88910bf57ad33bfcb6`
- Syntax: exit 0, 54/54; output hash `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Static: `grep -nE 'writeFile|deleteFile' Gatekeeper.js Sandbox_Engine.js` → NONE (read-only contract intact; Route_Cache_Manager.js remains sole writer)

## Deviations / notes

- `readCacheJson`/`sbReadCacheJson` are shared by route AND temp reads; the manager's route filter
  requires `dayClass` as a number and would reject valid temp entries (`dayClass`/`bucket` null).
  The inline filter is therefore kind-aware: route kind mirrors `rcmFilterRouteEntries`, temp kind
  mirrors `rcmFilterTempEntries` (complete reader/manager parity), order-cache reads keep their
  original `clusterKey`/`result` validation per the remediation scope.
- Three fixture corrections in `harness/test_cache_readers.js` follow from the key-integrity rule:
  two temp-cache fixtures used route-style keys and the parity matrix used symbolic keys; all now
  carry the manager-realistic `rcmRouteKey`/`rcmTempKey` shapes (insertion order preserved).
- No magic numbers; named `CACHE_MODE_WALK` constant per reader; `let`/`const` only; no Node-only
  constructs (`setTimeout`/`setInterval`/`Promise` absent).

## Workload / PR boundary

- Mode: single remediation PR (RED + GREEN + docs commits) — no chain needed
- Remediation diff (code + harness + docs, `7f7bced..HEAD`): under 400 changed lines
- `.atl/` files untouched and unstaged

## Next

R3 VERIFY: full harness suite, `node --check`, and the adversarial probe pattern; require
reader/manager parity on every invalid class and reader-origin LOG-17; 28/28 baseline green.
