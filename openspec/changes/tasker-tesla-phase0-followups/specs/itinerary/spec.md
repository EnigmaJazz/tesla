# Delta for Itinerary

> Canonical references: `INV-0.1..INV-0.8`, `§5 PLAN-5`, `§6 SEL-6`, `§10 OVR-10`, `§17 LOG-17`, and `§16 acceptance (AC-3/AC-5/AC-7)`.

## Canonical Impact

### MODIFIED

| Canonical references | Change |
|---|---|
| `INV-0.2; §5 PLAN-5` | Adds explicit same-location overnight acceptance and removes `_IN` suffix inference. Remaining text unchanged. |
| `INV-0.5; §4 TRIP-4; §13 MANUAL-13` | Adds reducer completion and later-day isolation acceptance. |
| `§5 PLAN-5; §6 SEL-6` | Adds queue-survival acceptance at local-day boundaries. |
| `INV-0.4` | Adds observable suppression acceptance without narrowing permitted policies. |
| `INV-0.7; §11 CACHE-11; §15 SCRIPT-15` | Completes the Sandbox-metrics fallback tier and nonzero publication proof. |
| `§10 OVR-10; §2 ID-2` | Completes Sandbox exact-key reads and compliant `coreId` parsing. |

### UNCHANGED

| Canonical references | Scope |
|---|---|
| `§20 Phase 2+ roadmap beyond already committed canonical behavior` | No additional roadmap behavior is introduced. |
| `existing DST helper implementations (test_dst_utc.js)` | Existing helper behavior remains unchanged. |
| `§11 CACHE-11 Gatekeeper typed cache-decision surface` | Gatekeeper's typed decision contract remains unchanged. |

## ADDED Requirements

### Requirement: REQ-AC3-1 — Explicit overnight handoff

The planner MUST create today's `EOD_RETURN`/ASAP and tomorrow's base-origin `PLANNED`/JIT head leg when same-location events cross local midnight. It MUST NOT infer the boundary from `_IN`.

#### Scenario: Same-location across midnight

- GIVEN same-location away-from-base events on consecutive local days
- WHEN the planner builds their legs
- THEN today MUST end with an EOD return and tomorrow MUST begin base/JIT
- AND `EVT-OVERNIGHT_BOUNDARY_CREATED` MUST be logged

### Requirement: REQ-AC3-2 / REQ-0B-1 — DST-safe planning day

Every leg MUST receive a timezone-derived `planningDay`; fixed-second day inference MUST NOT be used.

#### Scenario: DST-transition day

- GIVEN events span local midnight on a DST-transition day
- WHEN their planning days are assigned
- THEN the boundary MUST follow the configured timezone
- AND each leg MUST belong to the correct local day

### Requirement: REQ-AC7-1 — Boundary-safe queue flush

Queue flushing and chain propagation MUST stop at, and MUST NOT consume work beyond, the local planning-day boundary.

#### Scenario: End-of-day flush

- GIVEN current-day work reaches an EOD flush while tomorrow remains queued
- WHEN the flush executes
- THEN tomorrow's entries MUST survive unchanged
- AND `EVT-CROSS_DAY_CHAIN_REJECTED` MUST be logged for rejected propagation

### Requirement: REQ-AC5-1 / REQ-0E-1 — Manual-return completion

Confirmed base arrival MUST submit `COMPLETE_TRIP`, complete today's manual return, and leave later-day trips unchanged.

#### Scenario: Manual return completes today

- GIVEN an active manual return and a planned trip tomorrow
- WHEN base arrival is confirmed
- THEN today's trip MUST become `COMPLETED`
- AND tomorrow MUST remain `PLANNED` and JIT

### Requirement: REQ-AC5-2 — Future-day selection isolation

Dispatcher MUST NOT select a future planning-day trip before its due window.

#### Scenario: Tomorrow is the only candidate

- GIVEN tomorrow's `PLANNED`/JIT trip is the only remaining candidate
- WHEN Dispatcher selects actionable work today
- THEN it MUST select no trip
- AND `EVT-FUTURE_TRIP_NOT_DUE` MUST be logged

### Requirement: REQ-INV0_4-1 — Observable synthetic-return suppression

Unplanned empty-day movement MUST NOT create a return unless an existing permitted policy applies.

#### Scenario: Unplanned empty-day movement

- GIVEN movement occurs with no remaining planned travel or permitted return policy
- WHEN planning runs
- THEN no return leg MUST be created
- AND `EVT-SYNTHETIC_RETURN_SUPPRESSED` MUST be logged

### Requirement: REQ-INV0_7-1 — Nonzero duration fallback

Compiler MUST use validated API metrics, Sandbox metrics, or a supported local active-travel estimate, in that order; otherwise it MUST reject the leg. Zero-duration travel MUST NOT publish.

#### Scenario: Cache miss

- GIVEN validated API metrics are unavailable and positive Sandbox metrics exist
- WHEN Compiler resolves travel duration
- THEN it MUST use the Sandbox metrics and publish a positive duration
- AND `EVT-DEPARTURE_POLICY_FALLBACK_USED` MUST be logged

### Requirement: REQ-OVR10-1 — Exact-key Sandbox reads

Sandbox override and preference membership MUST use exact keys, never substring matching.

#### Scenario: Decoy occurrence IDs ev_1 vs ev_10

- GIVEN exact keys `ev_1` and `ev_10` coexist
- WHEN Sandbox reads or changes `ev_1`
- THEN `ev_10` MUST remain unchanged

### Requirement: REQ-OVR10-2 — Last-underscore core parsing

Sandbox MUST derive `coreId` using the final underscore and a valid base-36 Unix suffix.

#### Scenario: Core containing underscores team_event_alpha_kx8f00

- GIVEN occurrence ID `team_event_alpha_kx8f00`
- WHEN Sandbox parses it
- THEN the core MUST be `team_event_alpha`
- AND the suffix MUST be validated independently

### Requirement: REQ-LOG-1 — Structured decision evidence

Boundary, isolation, suppression, and fallback decisions MUST append JSON containing `timestamp`, `generationId`, `component`, `severity`, `code`, `tripId`, and `details`.

#### Scenario: Decision is logged

- GIVEN a covered decision occurs
- WHEN its evidence is emitted
- THEN `code` MUST be the applicable `EVT-OVERNIGHT_BOUNDARY_CREATED`, `EVT-CROSS_DAY_CHAIN_REJECTED`, `EVT-FUTURE_TRIP_NOT_DUE`, `EVT-SYNTHETIC_RETURN_SUPPRESSED`, or `EVT-DEPARTURE_POLICY_FALLBACK_USED`
- AND every required `LOG-17` field MUST be present
