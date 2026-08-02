# Delta for Itinerary

> Canonical references: ID-2, PUB-7, RULE-8C, CMD-9, OVR-10, SCRIPT-15, LOG-17, and VAL-18. The status line MUST record only verified scoped evidence.

## ADDED Requirements

### Requirement: Strict Occurrence-ID Parsing

Occurrence IDs MUST split at `lastIndexOf("_")`. The non-empty core MAY contain underscores; the base-36 suffix MUST decode within `[1000000000, 2500000000)`. All parser copies MUST reject invalid input without applying it. (ID-2, SCRIPT-15.)

#### Scenario: Valid ID
- GIVEN `google_abc123_kx8f00`
- WHEN an occurrence consumer parses it
- THEN it MUST return core `google_abc123` and Unix value `1265143536`

#### Scenario: Invalid ID
- GIVEN an empty, separator-free, empty-core, trailing-garbage, or out-of-range ID
- WHEN parsing is attempted
- THEN the consumer MUST reject and skip the occurrence or command

#### Scenario: Rejection logging
- GIVEN an ID is rejected
- WHEN the rejection is handled
- THEN JSON MUST use `ID_PARSE_REJECTED`, LOG-17 fields, `details.rawId`, and `details.reason`

### Requirement: Override Resource Single Writer

Only Override Handler MUST write `TDS_Overrides.json` or `TDS_Routine_Preferences.json`. The seven former writers—Alpha, Appender, Compiler, Default, Finaliser, Override Injector, and Stop Logger—MUST use staged commands or documented transient globals. (RULE-8C, SCRIPT-15.)

#### Scenario: Seven-writer ownership guard
- GIVEN each former writer attempts its supported workflow
- WHEN the harness records resource writes
- THEN only Override Handler MAY write either protected file, and unauthorized writes MUST be rejected

### Requirement: Serialized Override Command API

Override Handler MUST process serial commands with `par1` as operation and `par2` as JSON payload. Adapters MUST stage the next Handler action; the harness MAY call `handler(op, payload)`. Membership MUST use exact-key maps, never substrings. (CMD-9, OVR-10.)

#### Scenario: APPLY_OVERRIDE
- GIVEN a valid occurrence and override category
- WHEN `APPLY_OVERRIDE` runs
- THEN it MUST toggle that exact key and remove only exact conflicting-category keys

#### Scenario: APPEND_OVERRIDE
- GIVEN a valid occurrence, category, and route context
- WHEN `APPEND_OVERRIDE` runs
- THEN it MUST append the exact override and update compatible learned history

#### Scenario: SET_DEFAULT
- GIVEN a route preference key and set, clear, or clear-all intent
- WHEN `SET_DEFAULT` runs
- THEN it MUST update `Route_Defaults` and related `Route_History` consistently

#### Scenario: PRUNE
- GIVEN current time, whitelist, persisted overrides, and transient memories
- WHEN `PRUNE` runs
- THEN it MUST preserve whitelisted/relevant exact IDs, remove expired IDs, and retain bounded timing

#### Scenario: Substring decoy
- GIVEN `abc123_kx8f00` and `xyzabc123_kx8f00` coexist
- WHEN the first key is removed or moved
- THEN the second key MUST remain unchanged

### Requirement: Protected Preference Migration

On first Handler use, legacy `Route_Defaults` and `Route_History` MUST migrate once to preferences and leave overrides. Deployment MUST snapshot both resources; failure MUST preserve original bytes, and rollback MUST restore prior bytes or absence. (RULE-8C, OVR-10.)

#### Scenario: Successful migration
- GIVEN legacy values exist only in `TDS_Overrides.json`
- WHEN the Handler first runs
- THEN preferences MUST contain both values and overrides MUST contain neither key

#### Scenario: Failed migration rollback
- GIVEN protected snapshots and an injected write failure
- WHEN migration cannot complete
- THEN original data MUST remain recoverable without a partial authoritative state

### Requirement: Injector Committed-Generation Input

`Override_Injector.js` MUST use `readActiveGeneration('itinerary')`, including its legacy fallback, and MUST NOT create a divergent reader. (PUB-7, SCRIPT-15.)

#### Scenario: Manifest-backed injection
- GIVEN a manifest names the active versioned itinerary
- WHEN an override is injected
- THEN the target MUST come from that committed generation and dispatch through Override Handler

### Requirement: Verification and Status Evidence

The harness MUST cover parsing, four operations, exact keys, migration/rollback, manifest input, and ownership. Passing status evidence MUST cover only ID-2/RULE-8C/SCRIPT-15, not AC-3/5/7, synthetic/manual returns, or Sandbox OVR-10 cleanup. (VAL-18.)

#### Scenario: Evidence update
- GIVEN every scoped harness assertion passes
- WHEN canonical status evidence is updated
- THEN it MUST identify the scoped tests and preserve all stated exclusions as open
