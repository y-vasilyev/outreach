## ADDED Requirements

### Requirement: Profile read API surfaces per-section observation freshness

The blogger profile read API SHALL include a `freshness` object on the profile detail response that reports per-section *observation freshness* for the rolled-up fields. Each section (`rateCards`, `audience`, `topics`, `languages`, `formats`, `reach`, `avgViews`) SHALL carry `{ stale: boolean, ageDays: number | null }`. A section's timestamp SHALL come from the newest data point that both (a) classifies to that category and (b) whose value would be picked up by the profile roll-up's value filters. If no such point exists the section SHALL be reported `{ stale: true, ageDays: null }` — there is no fallback to a profile-level timestamp. Usable `rate.<format>` points SHALL count toward `formats` freshness in addition to `rateCards`, mirroring how the rolled-up `formats` union derives from rate cards. The TTLs SHALL be category-specific (rate cards / reach / average views: 90 days; audience: 180 days; topics / languages / formats: 365 days) and SHALL live in shared code so workers and UI can call the same classifier.

The signal is observation freshness, NOT the age of the displayed rolled-up value. The roll-up's confidence-band-then-recency arbitration can pick an older high-confidence value over a newer low-confidence one, so a section can be reported fresh even when the displayed value is older. The `dataPoints` array on the same response provides the per-point provenance operators need to audit which observation the roll-up chose.

#### Scenario: Fresh rate card section
- **WHEN** the profile has a numeric `rate.<format>` data point captured within the rate-card TTL
- **THEN** `freshness.rateCards` is `{ stale: false, ageDays: <days since that point> }`

#### Scenario: Stale rate card section
- **WHEN** the most recent contributing `rate.*` data point was captured longer ago than the rate-card TTL
- **THEN** `freshness.rateCards.stale` is `true` and `ageDays` reflects that age

#### Scenario: Fresh non-contributing point does not mark a section fresh
- **WHEN** a fresh `rate.post` data point has a non-numeric value (e.g. "договорная") and the only contributing rate-card point is older than the TTL
- **THEN** `freshness.rateCards.stale` is `true` and `ageDays` reflects the older contributing point's age, so the signal matches what the rolled-up rate cards actually show

#### Scenario: Section with no contributing data points is stale-by-default
- **WHEN** a section (e.g. `topics`) has no data point that classifies to it and contributes to the rolled-up view
- **THEN** the section is reported as `{ stale: true, ageDays: null }` so the operator sees a warning rather than a silent gap, even if other sections have fresh points

#### Scenario: Rate card observations contribute to formats freshness
- **WHEN** a profile has a usable `rate.<format>` data point but no explicit `formats|format` data point
- **THEN** `freshness.formats` follows the rate card's age, matching the rolled-up `formats` union which derives from rate cards

#### Scenario: Unrendered audience sub-dims do not affect audience freshness
- **WHEN** a profile has a usable `audience.income` data point but no `audience.geo|age|gender` points
- **THEN** `freshness.audience` is `{ stale: true, ageDays: null }`, because the rolled-up audience view only renders `geo`/`age`/`gender`
