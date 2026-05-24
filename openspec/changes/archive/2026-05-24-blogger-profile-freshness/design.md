## Context

`BloggerProfile` carries one `capturedAt` (newest contributing data point's timestamp) and the granular `ProfileDataPoint` rows each carry their own `capturedAt`. Operators currently get no signal that a profile section is old; the release-blocker review specifically called out rate cards (which shift quarterly). A blogger we last priced in November may still display the same rate cards in May with no warning, leading the operator (or future matching scorer) to treat the value as fresh.

We want a *minimal, derived, read-only* freshness signal — no schema change, no background job, no per-row mutation. Roll forward later if/when matching wants to penalize stale data points in scoring.

## Goals / Non-Goals

**Goals:**
- Per-section *observation freshness* on the profile read API: `rateCards`, `audience`, `topics`, `languages`, `formats`, `reach`, `avgViews` each get `{ stale: boolean, ageDays: number | null }` indicating the age of the newest usable contributing observation for that section.
- Per-category TTLs are constants in shared, easily tunable without a migration.
- Pure functions in `packages/shared` so workers/UI can also call them deterministically.
- A fresh-but-unusable point (e.g. `rate.post = "договорная"`) does NOT mark a section fresh.

**Non-Goals:**
- Background re-extraction triggered by staleness (manual operator follow-up only).
- Per-data-point `stale` flag in the response (the rolled-up section is enough — the dataPoints list still carries its own `capturedAt` so the operator can drill down).
- Web UI integration (this PR delivers backend; UI follow-up in a separate PR).
- Persisted staleness columns or indexes (we compute on read).
- Matching scoring integration (out of scope here).

## Decisions

### D1: TTLs per category, not per field

Each `ProfileDataPoint.field` (`rate.story`, `audience.geo`, `topics`, …) is classified into one of: `rateCards`, `audience`, `topics`, `languages`, `formats`, `reach`, `avgViews`. TTLs are set per category, not per field. Rationale: fields are dense (`rate.story`, `rate.post`, `rate.reels`, `rate.shorts`, …) and per-field TTL tuning has no business signal; per-category is what operators reason about ("rate cards expire after a quarter"). Alternatives considered: per-field map (too granular), single global TTL (too coarse — `topics` move much slower than `rate`).

Values chosen, sources from typical creator-marketing churn:
- `rateCards`, `reach`, `avgViews`: **90 days**. Pricing and reach respond to platform algorithm shifts (Q1 vs Q2 is meaningful).
- `audience`: **180 days**. Demographics drift slowly.
- `topics`, `languages`, `formats`: **365 days**. Largely identity-level for the blogger.

### D2: A section's freshness comes from its newest *contributing* point — no fallback

For each category we take the newest data point that (a) classifies to that category AND (b) whose `value` would be picked up by `rollUpProfileFields` for that category (`isContributingValue` mirrors rollup's filters: numeric for rate/reach/avgViews, non-empty share record for audience, non-empty string list for topics/languages/formats). If no point meets both bars, the section is `{ stale: true, ageDays: null }` — explicit miss.

Rationale: an earlier draft fell back to `profile.capturedAt` when a category had no contributing point, but `profile.capturedAt` is the newest point across the *whole* profile. A profile with only a fresh `rate.post` would then mark `topics`, `languages`, `formats`, `reach`, `avgViews` all fresh-by-accident. The fallback also hid the "fresh-non-contributing" failure mode: a fresh `rate.post = "договорная"` would have marked rateCards fresh even though the displayed rate card was the older numeric point (caught in codex R1). Dropping the fallback and gating on usability fixes both at once.

### D2a: Observation freshness, not displayed-value freshness

`rollUpProfileFields` arbitrates value selection by *confidence-band-then-recency*: an older 0.9-confidence rate can beat a newer 0.6-confidence rate. We deliberately do NOT replicate that selection logic here. The signal we emit is **the age of the newest usable observation per section**, not "is the displayed chosen value fresh?".

Rationale: (a) operators ask "do we have recent enough data on this section?" — observation freshness directly answers that. (b) Re-implementing rollup's confidence-band sort here would double the surface area we have to keep in sync, and any future tweak to rollup's arbitration would silently desync the freshness signal. (c) The `dataPoints` array on the same response gives operators the per-point provenance they need to audit *which* observation rollup chose; the rolled-up section's own `capturedAt` (already on `BloggerProfile`) covers "newest point in the profile".

Implication: a section can be reported fresh even when the displayed value rollup picked is older (a newer lower-confidence observation existed). This is intentional. The JSDoc and spec call this out explicitly so downstream consumers don't conflate the two signals.

### D2b: Rate cards cross-contribute to formats

`rollUpProfileFields` derives the displayed `formats` array as the union of explicit `formats|format` points and the rate cards' formats. To match that rendering, a usable `rate.<format>` point counts toward both `rateCards` freshness and `formats` freshness. Without this, a profile whose only formats source is the rate card would show fresh rate cards alongside permanently stale formats — a contradiction.

### D2c: Audience classifier narrowed to rendered dims

`rollUpProfileFields` only renders `audience.geo`, `audience.age`, and `audience.gender`. Other `audience.*` prefixes (e.g. `audience.income`, `audience.interests`) do not affect the displayed audience and so do not affect freshness either. When an extractor + rollup learn to render a new audience dim, add it to `classifyProfileField`.

### D3: Compute on read, not write

The freshness object is computed inside `bloggerProfilesService.get` from the already-fetched `dataPoints`. No DB column, no migration. Cost: an O(N) pass over data points. Rationale: profiles have at most a few dozen data points; the cost is negligible, and computing on read means TTL tweaks roll out the moment we redeploy without a backfill.

### D4: Shape — `freshness: Record<Category, { stale, ageDays }>`

Returning a flat record (not an array) lets the frontend pick exactly the section it wants without filtering. `ageDays` is null when no contributing point exists. Alternative considered: a single boolean per profile (too coarse; operators want to know *which* section is stale).

## Risks / Trade-offs

- **TTL tuning is a guess** → Mitigation: constants are in `profile-staleness.ts`, easy PR to change. Surface in CHANGELOG when retuning.
- **Categories miss a field if a new extractor ships a new prefix** → Mitigation: `classifyProfileField` falls back to `null`, the uncategorized field doesn't affect any section, and there is a comment pointing future extractor authors at this map.
- **Usability checks duplicate rollup logic** → Mitigation: the two predicates (`isContributingValue` here, the inline checks in `rollUpProfileFields`) are co-located in `packages/shared/src` and the comment in `profile-staleness.ts` calls out that they must move together. A future refactor could share predicates; out of scope here.

## Migration Plan

Pure additive: ship `freshness` on `GET /blogger-profiles/:id`. Frontend ignores unknown fields. Rollback = revert the PR.

## Open Questions

- Should matching consider freshness in scoring? *Out of scope here.* The signal is now available for whoever builds that.
