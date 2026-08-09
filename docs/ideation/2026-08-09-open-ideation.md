---
date: 2026-08-09
topic: open-ideation
mode: repo-grounded
---

# Ideation: Tesla Tasker Scheduler — Open-Ended Improvement Ideas

## Grounding Context

**Codebase context:** Tasker Android JSlet scheduler for a Tesla — ~20 standalone `.js` scripts, no Node/require/npm; communication via Tasker locals/globals (`%par1`/`%par2` envelopes) and JSON files; profile-driven (time, location, manual, HTTP response); no polling loops. Single-writer contract per data file; structured JSON logging with fixed event codes; mid-upgrade against a 19-section architectural spec (Phase 6 followups archived, later phases pending). Testing = `harness/` plain-Node vm sandbox (`mock_tasker.js`), one `node harness/test_*.js` per test. **No aggregate runner, no CI, no linter/typechecker/formatter — code review is the only safety net.**

**Past learnings (from archived SDD reports):** harness has caught real production bugs (depUnix typo) — extending it is proven high-leverage; false-PASS harness history (tests asserted the manager's log while direct readers accepted poison entries); scenarios written against invented event codes that don't exist at runtime (`OBSERVE_DEPARTURE_ACCEPTED` still unmatched); committed tests lag the contract (ad-hoc `/tmp` adversarial probes needed); var vs let redeclaration hazard in shared vm; serial model only-delivers-last-`%par1` clobbering; `--no-verify` commits after GGA hook failure; line budgets repeatedly exceeded; spec-sync gaps for archived phases.

**Observed pain points:** doc drift (harness README lists 8 tests vs openspec config's 28; script counts 18 vs 20); staged-locals persistence across JSlet action boundaries only manually validated on-device; `%par1`/`%par2` double-duty + manual copy dance for the release chain (`tds_release_par1` → `%par1`), hand-configured per device; per-device config gitignored → drift invisible.

## Ranked Ideas

### 1. Aggregate harness runner with pinned manifest
**Description:** Zero-dependency `harness/run_all.js` that discovers every `test_*.js`, runs each in a fresh vm context, prints a PASS/FAIL table with counts, and exits nonzero on any failure. A manifest pins the expected test list so added or missing tests fail the run (no silent drift). `--only <name>` supports focused dev runs. Becomes the pre-commit/post-change gate.
**Warrant:** `direct:` — no aggregate runner exists; harness README lists 8 tests while openspec config claims 28 (drift is only visible because there is no single gate); the harness already caught a real bug (depUnix typo), so making it one command compounds proven leverage.
**Rationale:** Keystone — every other gate (lint, probes, coverage) rides on a single "did everything pass" command. Replaces the documented `|| break` loop that stops at the first failure.
**Downsides:** None material; small maintenance surface as the suite grows.
**Confidence:** 95%
**Complexity:** Low
**Status:** Unexplored

### 2. Multi-action chain simulator (staged-locals persistence offline)
**Description:** Harness support to execute a sequence of production scripts (e.g. Alpha → Compiler → Finaliser → Reducer) in one run, carrying staged locals and files across simulated JSlet action boundaries exactly as Tasker does — with clobbered-`%par1` detection and a fresh vm context per action (kills var-redeclaration bleed by construction).
**Warrant:** `direct:` — "staged-locals persistence across Tasker JSlet action boundaries is only validated by manual on-device smoke tests — the riskiest runtime premise"; serial model only-delivers-last-`%par1` clobbering is the root defect behind two archived batch changes.
**Rationale:** Moves the single riskiest runtime assumption from a manual phone smoke test into every test run; converts serial-delivery clobbering from review lore into an automated check.
**Downsides:** Highest implementation cost of the survivors; needs careful mock fidelity to avoid testing a fictional Tasker.
**Confidence:** 85%
**Complexity:** High
**Status:** Unexplored

### 3. AGENTS.md hard rules as machine-checkable lint
**Description:** Zero-dependency Node checker encoding the hard rules: no unbounded time conditions, `lastIndexOf("_")` occurrence-ID parsing, no substring event-ID matching, no writes outside the single-writer table, no Node-only APIs, no magic numbers, no zero-duration fallbacks. Runs statically across all scripts from the harness.
**Warrant:** `direct:` — the rules already exist as prose in AGENTS.md while "code review is the safety net"; var/let redeclaration hazard and single-writer violations are review-caught today; archives show repeated line-budget and rule drift.
**Rationale:** Every rule the machine can check is one less human-review failure per phase, and the check list grows with each new spec phase.
**Downsides:** Static analysis of dynamic JS is approximate — needs a "not sure" exit code to avoid false confidence.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 4. Assert file truth, not manager logs + committed probe library
**Description:** Harness rule: file-state assertions must read through the same readers production uses (never the writer's own log claims); add `assertLogged(code, ...)` on structured-log capture and negative assertions (`mustNotContain`); package the ad-hoc `/tmp` adversarial probes (poison-entry readers, depUnix-style hunts, day-boundary/DST edges) into `harness/probes/` run by the aggregate runner.
**Warrant:** `direct:` — archived false-PASS: "tests asserted the manager's log while direct readers accepted poison entries (7/11 adversarial FAILs)"; committed tests lag the contract, requiring throwaway `/tmp` probes that found real bugs (depUnix typo).
**Rationale:** Kills the worst failure class in this project's history (certifying broken behavior as passing) and makes proven adversarial coverage permanent instead of re-derived per phase.
**Downsides:** Requires discipline in new tests; probe maintenance cost as contracts evolve.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 5. Spec-as-contract: executable spec JSON
**Description:** Extract the 19-section spec's normative parts (event codes, writer map, invariants, phase→test coverage) into one versioned JSON contract file. Harness validates every script's log calls against the registry (invented codes fail), validates declared writers vs actual file writes, and emits a per-phase coverage report (a phase is "done" only when its manifest rows are green). Docs (README test/script counts) become generated output with a drift check. The archive step self-appends the phase's delta into the canonical spec, closing "no canonical section" gaps.
**Warrant:** `direct:` — "scenarios written against invented event codes that don't exist at runtime" recurred across phases (`OBSERVE_DEPARTURE_ACCEPTED` still unmatched); doc drift (8 vs 28 tests, 18 vs 20 scripts); archived phases left spec-sync gaps.
**Rationale:** Makes the spec machine-checkable instead of prose-consensus; kills the invented-code and doc-drift failure classes at authoring time; turns "is the phase done" into a checkable question.
**Downsides:** Biggest scope of the survivors (registry + writer analysis + coverage + docs gen); the contract JSON itself can drift from prose if not maintained as canonical.
**Confidence:** 75%
**Complexity:** High
**Status:** Unexplored

### 6. Single-envelope command channel + clobber guard
**Description:** Replace `%par1` double-duty (command name OR JSON payload) with one always-JSON envelope `{cmd, generationId, payload}`; `%par2` reserved for a fixed header (version + length) so truncation is detectable. One shared parse function instead of per-script sniffing. The `tds_release_par1` → `%par1` copy dance collapses to a single Tasker action. Add `ENVELOPE_CLOBBERED` logging with sequence numbers so silently lost envelopes become diagnosable.
**Warrant:** `direct:` — "`%par1`/`%par2` double-duty (command name OR JSON payload) plus the manual copy dance... fragile Tasker wiring, hand-configured per device"; "serial model only-delivers-last-`%par1` clobbering".
**Rationale:** Removes the root of the two most fragile wiring classes (double-duty parsing + last-wins clobbering) and the per-device manual copy step, while making any residual loss loud.
**Downsides:** Touches every entry point and consumer — needs the chain simulator (idea 2) to verify; Tasker-side variable-set rewiring is manual.
**Confidence:** 75%
**Complexity:** Medium-High
**Status:** Unexplored

### 7. Deploy bundle with checksums + `tds_doctor` self-check
**Description:** Harness-side script generates `release_bundle.json` (every runtime `.js` + sha256 + expected manifest). On-device side verifies what was actually deployed, logging `DEPLOY_VERIFIED`/`DEPLOY_MISMATCH`. Plus a `tds_doctor` Tasker-callable script: validates every TDS file's presence/JSON-validity, staged-locals consumer wiring, and config against a committed template (`configVersion` stamped into logs, drift reported); emits one structured `HEALTH_REPORT` event + flash notification.
**Warrant:** `direct:` — "staged-locals persistence... only validated by manual on-device smoke tests"; "per-device config is gitignored → config drift invisible"; hand-configured per-device wiring with no deployment verification.
**Rationale:** Turns "did it actually work?" from file-poking on a phone into a one-tap check, and makes deployment drift a log line instead of an invisible divergence.
**Downsides:** Two new small scripts to maintain; Tasker-side verification is only as good as what the bundle covers.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | On-device log triage view | Below ambition floor; fold into tds_doctor (survivor 7) if built |
| 2 | Repo health check script | Duplicates survivors 1/3/5 — runner + lint + docs drift already cover it; unique bits (line budgets) fold into 3/5 |
| 3 | Serial-delivery clobber guard (standalone) | Subsumed by survivor 6 (envelope rework removes last-wins at root; loud-guard is part of its scope) |
| 4 | Fresh-context-per-test vm isolation | Folded into survivor 2 (chain simulator requires fresh contexts per action anyway) |
| 5 | Generated docs standalone | Folded into survivor 5 (docs_gen + drift check is one of its outputs) |
| 6 | Event-code registry standalone | Folded into survivor 5 (registry is the core of the contract file) |
| 7 | Phase→test contract manifest | Folded into survivor 5 (coverage report is one of its outputs) |
| 8 | Tasker profiles as generated artifacts | Too expensive relative to value; survivors 6+7 capture the wiring/deploy value |
| 9 | Append-only event log | Too expensive mid-upgrade; no evidence of actual torn-write corruption — single-writer contract works |
| 10 | Consolidate ~20 scripts into lifecycle modules | Conflicts with the Tasker profile invocation model; single-writer table is a feature, not a bug; too expensive mid-upgrade |
| 11 | Typed core compiled to Tasker bundle | Duplicates the vm harness's value (it tests the real shipped scripts); would test a different artifact than what ships |
| 12 | Config contract standalone | Folded into survivor 7 (template + version stamp + drift report) |
