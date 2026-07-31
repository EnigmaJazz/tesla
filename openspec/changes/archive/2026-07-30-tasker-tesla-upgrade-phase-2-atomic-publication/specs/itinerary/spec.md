# Spec Delta: itinerary — Phase 2 Atomic Publication

## Purpose

This delta makes a validated generation the indivisible publication unit: one Publisher writes versioned resources, exposes them through a manifest written last, preserves a recoverable committed generation, and propagates generation identity to readers and logs.

## ADDED Requirements

### Requirement: Generation ID Format

The Generation Publisher SHALL mint each ID as `gen:<unixSec>:<4hex>`, where `unixSec` is exactly 10 decimal Unix-seconds digits and `4hex` is exactly four lowercase hexadecimal characters. It SHALL reject malformed IDs and SHALL mint another suffix if the candidate already exists.

#### Scenario: Collision avoidance
- GIVEN an existing generation has the candidate ID
- WHEN another generation is minted in the same second
- THEN the Publisher SHALL mint a different valid suffix

#### Scenario: Parsing
- GIVEN `gen:1784369000:ab12`
- WHEN a consumer parses it
- THEN it SHALL obtain `1784369000` and `ab12`

### Requirement: Generation Lifecycle States

Each candidate generation SHALL enter `building`, then transition to exactly one terminal state: `committed` after successful publication or `failed` after validation/publication failure. Its manifest state SHALL represent that outcome; failure SHALL log `GENERATION_VALIDATION_FAILED` and SHALL NOT promote the candidate.

#### Scenario: Build begins
- GIVEN no candidate generation
- WHEN the Publisher starts a generation
- THEN its state SHALL be `building`

#### Scenario: Successful transition
- GIVEN a generation in `building`
- WHEN every resource and the manifest are published
- THEN its state SHALL become `committed`

#### Scenario: Failed transition
- GIVEN a generation in `building`
- WHEN validation or publication fails
- THEN its state SHALL become `failed` and SHALL NOT later become `committed`

### Requirement: TDS Run Manifest Schema

`TDS_Run_Manifest.json` SHALL be updated only by the Generation Publisher and SHALL contain: `schemaVersion` (positive schema integer), `activeGeneration` (current readable ID), `previousGeneration` (recovery ID immediately preceding the current attempt, or `null`), `publishedAt` (Unix seconds), `writer` (`Generation Publisher`), `eventsPath`, `masterPath`, and `itineraryPath` (exact co-located resource paths), `eventCount` (records at `eventsPath`), `legCount` (leg records at `masterPath`), `itineraryCount` (entries at `itineraryPath`), and `state` (`building|committed|failed`). Counts SHALL equal their validated resources.

#### Scenario: First publication
- GIVEN no prior manifest
- WHEN generation A commits
- THEN active SHALL be A, previous SHALL be `null`, and counts SHALL match

#### Scenario: Superseding publication
- GIVEN committed generation A
- WHEN generation B commits
- THEN active SHALL be B and previous SHALL be A

#### Scenario: Failed publication
- GIVEN committed generation A and candidate B
- WHEN B fails
- THEN active and previous SHALL be A and state SHALL be `failed`

### Requirement: Versioned File Naming

The Publisher SHALL co-locate resources in the existing data directory as `TDS_Events.<fileGen>.json`, `TDS_Master.<fileGen>.json`, and `Itin_Master.<fileGen>.json`. `<fileGen>` SHALL replace each `:` in the canonical ID with `_`; manifest generation fields retain colons and path fields contain the encoded filenames.

#### Scenario: Colon-safe encoding
- GIVEN generation `gen:1784369000:ab12`
- WHEN paths are assigned
- THEN `<fileGen>` SHALL be `gen_1784369000_ab12`

### Requirement: Manifest-Last Publication Order

The Publisher SHALL write events, master, itinerary, then manifest. Published files MUST NOT be cleared or incrementally rebuilt. Until the final manifest succeeds, the prior committed pointer SHALL remain authoritative; a failed candidate SHALL be recoverable by a later generation.

#### Scenario: Successful order
- GIVEN a validated candidate
- WHEN it is published
- THEN writes SHALL occur events → master → itinerary → manifest

#### Scenario: Events write fails
- GIVEN a prior committed manifest
- WHEN the events write fails
- THEN the candidate SHALL fail, no later write SHALL occur, and the prior pointer SHALL remain authoritative

#### Scenario: Master write fails
- GIVEN events were written
- WHEN the master write fails
- THEN the candidate SHALL fail, later writes SHALL stop, and the prior pointer SHALL remain authoritative

#### Scenario: Itinerary write fails
- GIVEN events and master were written
- WHEN the itinerary write fails
- THEN the candidate SHALL fail, the commit manifest SHALL NOT be written, and the prior pointer SHALL remain authoritative

#### Scenario: Manifest write fails
- GIVEN all candidate resources were written
- WHEN the manifest write fails
- THEN the prior committed manifest SHALL remain authoritative and the candidate SHALL be failed

### Requirement: Committed Generation Discovery

Readers including Dispatcher, Dashboard, and Finaliser SHALL read the manifest first and SHALL consume only the exact paths it declares. A committed active generation is preferred; otherwise readers SHALL use the last readable prior generation when available, or an empty state with idle dispatch when none exists.

#### Scenario: Active generation
- GIVEN a valid committed manifest for A
- WHEN a reader loads scheduler data
- THEN it SHALL read only A's declared paths

#### Scenario: Prior-generation fallback
- GIVEN the manifest is absent, corrupt, unreadable, or non-committed and a prior generation is known
- WHEN a reader loads scheduler data
- THEN it SHALL read that prior generation

#### Scenario: Empty fallback
- GIVEN no readable active or prior generation
- WHEN a reader loads scheduler data
- THEN it SHALL return empty data and Dispatcher SHALL use idle sync

### Requirement: Generation ID Propagation

On commit the Publisher SHALL set `TDS_Active_Generation` to the canonical ID. All eleven structured-log placeholder sites identified by the proposal SHALL use that global rather than `null`. The global SHALL be cleared when publication fails and SHALL begin empty after application restart.

#### Scenario: Commit
- GIVEN generation A commits
- WHEN structured events are emitted
- THEN the global and each placeholder SHALL contain A

#### Scenario: Failure
- GIVEN a candidate publication fails
- WHEN failure handling completes
- THEN the global SHALL be empty

#### Scenario: Restart
- GIVEN the application restarts
- WHEN no generation has committed in that process
- THEN the volatile global SHALL be empty

### Requirement: RULE-8A Remediation

Only the Generation Publisher SHALL write `TDS_Events.*.json`, `TDS_Master.*.json`, `Itin_Master.*.json`, or `TDS_Run_Manifest.json`. Gatekeeper and API Parser SHALL emit typed reorder commands for application before commit; Alpha SHALL NOT clear or otherwise touch published masters.

#### Scenario: Gatekeeper write removal
- GIVEN Gatekeeper decides a cluster reorder
- WHEN it returns the decision
- THEN the write formerly at `Gatekeeper.js:56` SHALL NOT occur

#### Scenario: API Parser write removal
- GIVEN API Parser decides a cluster reorder
- WHEN it returns the decision
- THEN the write formerly at `API_Parser.js:33` SHALL NOT occur

#### Scenario: Alpha clear removal
- GIVEN Alpha starts ingestion
- WHEN published files already exist
- THEN the clears formerly at `Alpha.js:392–393` SHALL NOT occur

### Requirement: Generation Retention

After successful commit, the Publisher SHALL prune committed generations beyond `PHASE2_RETENTION = 5`, retaining current plus four previous committed generations. It SHALL NOT prune committed recovery data before commit; failed generations MAY be pruned immediately.

#### Scenario: Normal retention
- GIVEN five retained committed generations
- WHEN a sixth commits
- THEN only the newest five SHALL remain

#### Scenario: Rapid commits
- GIVEN successive commits exceed retention
- WHEN each commit completes
- THEN pruning SHALL retain the newest five regardless of elapsed time

#### Scenario: First commit
- GIVEN no prior generation
- WHEN the first generation commits
- THEN it SHALL remain and no committed generation SHALL be pruned

### Requirement: Legacy Master Migration

On the first Phase 2 commit, validated `TDS_Master.json` and `Itin_Master.json` MAY seed the new generation. The Publisher SHALL write versioned resources before switching the manifest, SHALL make legacy names non-authoritative at that switch, SHALL cut all readers over together, and SHALL retain `TDS_Master.legacy.json` and `Itin_Master.legacy.json` for one release.

#### Scenario: First migration
- GIVEN valid legacy masters and no manifest
- WHEN the first Phase 2 generation commits
- THEN versioned resources SHALL be active and both legacy backups SHALL exist

#### Scenario: Rollback
- GIVEN retained legacy backups
- WHEN Phase 2 is rolled back within one release
- THEN the backups SHALL restore the legacy readable state before versioned publication is disabled

## MODIFIED Requirements

### Requirement: §7 Atomic publication — PUB-7

> Published files MUST NOT be cleared or incrementally rebuilt. Build versioned event/master/itinerary files, validate schema/generation/policy/day-boundaries/chains/positive durations/completion, write `TDS_Run_Manifest.json` last, and preserve prior generation on failure. Dashboard and Dispatcher read manifest first, then its exact generation. **Evidence:** §7. **Exception:** none.

Published files MUST NOT be cleared or incrementally rebuilt. The Generation Publisher SHALL validate and publish complete, versioned event/master/itinerary generations, write the manifest last, and preserve the prior committed generation on any failure. Every reader SHALL discover only committed data through manifest-declared paths and SHALL follow the specified prior-or-empty fallback. **Evidence:** §7. **Exception:** none.

(Previously: PUB-7 named manifest-last publication but did not define IDs, lifecycle, schema, failure branches, discovery fallback, retention, or migration.)

#### Scenario: No partial generation becomes active
- GIVEN publication fails before the manifest commits
- WHEN a reader discovers scheduler data
- THEN it SHALL observe the prior generation or empty state, never the candidate

### Requirement: §8 Persistent-state ownership — OWN-8

> Each resource has one writer:
>
> | Rule | Writer | Resources |
> |---|---|---|
> | RULE-8A | Generation Publisher | `TDS_Run_Manifest.json`, `TDS_Master.<generation>.json`, `Itin_Master.<generation>.json` |
> | RULE-8B | Trip State Reducer | `TDS_Trip_State.json` |
> | RULE-8C | Override Handler | `TDS_Overrides.json`, `TDS_Routine_Preferences.json` |
> | RULE-8D | Manual Action Handler | `TDS_Manual_Trips.json`, `TDS_Action_Sessions.json` |
> | RULE-8E | Route Cache Manager | `TDS_Route_Cache.json`, `TDS_Order_Cache.json` |
>
> Entry points MUST submit commands, not directly rewrite domain files. `TDS_Routine_Preferences.json` holds `Route_Defaults` and `Route_History`; Override Handler is its sole writer. `TDS_Overrides.json` MUST have Override Handler as its sole writer (reduced from seven writers). `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` writes move to ephemeral globals; their full persistence migration to `TDS_Trip_State.json` is Phase 3. **Evidence:** §8. **Exception:** none.

Each resource SHALL have one writer:

| Rule | Writer | Resources |
|---|---|---|
| RULE-8A | Generation Publisher | `TDS_Run_Manifest.json`, `TDS_Events.<generation>.json`, `TDS_Master.<generation>.json`, `Itin_Master.<generation>.json` |
| RULE-8B | Trip State Reducer | `TDS_Trip_State.json` |
| RULE-8C | Override Handler | `TDS_Overrides.json`, `TDS_Routine_Preferences.json` |
| RULE-8D | Manual Action Handler | `TDS_Manual_Trips.json`, `TDS_Action_Sessions.json` |
| RULE-8E | Route Cache Manager | `TDS_Route_Cache.json`, `TDS_Order_Cache.json` |

Entry points MUST submit commands, not directly rewrite domain files. `TDS_Routine_Preferences.json` holds `Route_Defaults` and `Route_History`; Override Handler is its sole writer. `TDS_Overrides.json` MUST have Override Handler as its sole writer. `Depart_Memory`, `Completed_Stops`, `Completed_Dropins`, and `Arrival_Memory` remain ephemeral globals pending Phase 3 migration to `TDS_Trip_State.json`. **Evidence:** §8. **Exception:** none.

(Previously: RULE-8A did not assign ownership of versioned `TDS_Events`.)

#### Scenario: Unauthorized write
- GIVEN any component other than the Generation Publisher
- WHEN it attempts to write a RULE-8A resource
- THEN the write SHALL be rejected
