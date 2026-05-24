## Why

Rolled-up blogger profile fields (rate cards, audience, topics, etc.) currently carry a single `capturedAt` timestamp but do not surface staleness to operators. A profile rolled up six months ago still looks "active" in the UI even if pricing has shifted under it. The release-blocker review flagged that *rate cards do not auto-expire*; operators have to remember per-channel how old each fact is. We need a minimal, backend-only signal that exposes per-section freshness so the admin UI (and future matching scoring) can show or filter on it without re-querying provenance.

## What Changes

- Add `packages/shared/src/profile-staleness.ts`:
  - Per-category TTL constants (rate cards 90d, reach/avgViews 90d, audience 180d, topics/languages/formats 365d).
  - `classifyProfileField(field)` — maps a raw `ProfileDataPoint.field` (e.g. `rate.story`, `audience.geo`, `topics`) to a category.
  - `isContributingValue(category, value)` — mirrors `rollUpProfileFields`'s usability filters (numeric for rate/reach/avgViews, non-empty share record for audience, non-empty string list for topics/languages/formats).
  - `isProfileFieldStale(field, capturedAt, now?)` — returns true when there is no capturedAt or `now − capturedAt > TTL`.
  - `computeProfileFreshness(dataPoints, now?)` — returns a `{ rateCards, audience, topics, languages, formats, reach, avgViews }` map of `{ stale: boolean, ageDays: number | null }` using the newest *contributing* data point per category. Sections with no contributing point are stale-by-default (no fallback to profile-level timestamp).
- `apps/api/src/services/blogger-profiles.ts#get`: include `freshness` on the response.
- Unit tests for each helper (TTL boundary, missing capturedAt, unknown field).
- No DB migration. No cron job. No write-path change. Read-only, derived signal.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `blogger-commercial-profile`: add a requirement that the profile read API surfaces per-section freshness (`stale` boolean + `ageDays`) based on per-category TTLs.

## Impact

- `packages/shared/src/profile-staleness.ts` (new), `packages/shared/src/index.ts` (re-export).
- `apps/api/src/services/blogger-profiles.ts` (extend `get` return shape).
- `apps/api/src/services/__tests__/blogger-profiles.test.ts` (assert new `freshness` field).
- No prisma schema changes. No queue/worker changes.
- Web UI: not in this change — admin can render `freshness` in a follow-up PR; the shape is documented in the spec delta so the frontend can consume it whenever convenient.
