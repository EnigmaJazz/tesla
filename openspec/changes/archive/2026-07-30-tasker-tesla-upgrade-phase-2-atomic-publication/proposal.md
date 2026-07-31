# Proposal: Phase 2 — Atomic Publication

## Intent

Replace mutable masters with single-writer, versioned, manifest-last publication. §1A says “emit `TDS_Events.<generationId>.json`”; §1B says “emit `Itin_Master.<generationId>.json`”; §7 says “Published files MUST NOT be cleared or incrementally rebuilt.”

## Scope

### In Scope
- Versioned events/master/itinerary, manifest discovery, retention, RULE-8A remediation, log IDs, and reader cutover.

### Out of Scope
- Atomic rename, append-only manifest audit, trip-state migration, typed protocols, and merging satellites into `Alpha.js`.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `itinerary`: atomic generation publication, committed-generation reads, and RULE-8A ownership.

## Approach

A Generation Publisher validates then writes versioned events, master, itinerary, and manifest last. This follows §1A/§1B outputs, §1D commit responsibility, §7 order, §8 ownership, and §12’s pre-publication clustering.

## Design decisions

1. **Generation ID** — **Decision:** `gen:<unixSec>:<4hex>`. **Rationale:** spec-aligned and serialised. **Alternatives:** counter, ULID, UUID. **Trade-off:** non-cryptographic uniqueness. **Detail:** spec.
2. **Manifest** — **Decision:** replaceable `schemaVersion`, `activeGeneration`, `previousGeneration`, `publishedAt`, `writer`, paths, counts, `state`. **Rationale:** pointer/recovery. **Alternatives:** append-only. **Trade-off:** §17 owns audit. **Detail:** spec.
3. **Atomicity** — **Decision:** manifest-last; preserve prior; `building|committed|failed`. **Rationale:** no Tasker rename. **Alternatives:** rename, WAL. **Trade-off:** eventual consistency. **Detail:** design.
4. **Readers** — **Decision:** committed manifest then exact paths; otherwise prior or empty/idle. **Rationale:** §7. **Alternatives:** latest-file scan. **Trade-off:** two reads. **Detail:** design.
5. **GC** — **Decision:** Publisher prunes post-commit, keeps current plus four via named constant. **Rationale:** bounded recovery. **Alternatives:** time/all/two. **Trade-off:** finite history. **Detail:** tasks.
6. **Logging ID** — **Decision:** Publisher sets `TDS_Active_Generation`; 11 `flash()` placeholders consume it. **Rationale:** correlation. **Alternatives:** arguments. **Trade-off:** transient global. **Detail:** tasks.
7. **Events fork** — **Decision:** add `TDS_Events.<gen>.json`. **Rationale:** §1A; removes hybrid drift. **Alternatives:** master-as-events. **Trade-off:** larger cutover. **Detail:** spec/design.
8. **RULE-8A** — **Decision:** Alpha:392–393 removes clears; Gatekeeper:56/API Parser:33 emit typed reorder decisions before commit. **Rationale:** §8/§12. **Alternatives:** Publisher-only reorder. **Trade-off:** command integration. **Detail:** design/tasks.
9. **Migration** — **Decision:** seed validated legacy data, cut over all readers, retain legacy for rollback. **Rationale:** no two truths. **Alternatives:** parallel reads. **Trade-off:** larger release. **Detail:** spec/design.

## Risks

- Stale readers/GC race — **design:** pointer validation and retention.
- Torn write/manifest corruption — **design:** Tasker recovery proof.
- Eleven null IDs, legacy window, and three RULE-8A writers — **tasks:** exhaustive harness checks.

## Rollback Plan

Restore the prior pointer and retained generation; revert the reader cutover as one release; re-enable legacy only with publication disabled.

## Acceptance criteria for the proposal itself

- [ ] All nine decisions are accepted with stated rationale and downstream owner.
- [ ] The spec delta preserves §1A/§1B/§7/§8/§12 alignment and one-writer ownership.

## Open questions for spec/design phases

- Confirm Tasker single-call `writeFile` interruption semantics and colon-safe filenames.
- Define validation/count semantics and exact corrupt-manifest fallback behaviour.
