# price-normalization Specification

## Purpose
TBD - created by archiving change price-normalization-v2. Update Purpose after archive.
## Requirements
### Requirement: Operator-maintained current exchange rates

The system SHALL store the current exchange rate per currency in an `exchange_rate` table `{ currency, rateToRub, asOf, source, updatedById, updatedAt }`, editable by admin users in Settings; an edit overwrites the row (no rate history table — historical traceability is provided by the per-offer `fxRateUsed`/`fxAsOf` stamps, which rate edits never rewrite on superseded rows). The table SHALL be empty at seed; while a currency has no rate, offers in that currency SHALL remain visible but unnormalized (excluded from RUB comparisons), never normalized with an invented rate.

#### Scenario: Admin sets a rate

- **WHEN** an admin sets USD = 92.4 effective 2026-06-01 in Settings
- **THEN** the rate row stores the value, `asOf`, and the editing user, and active USD offers are renormalized

#### Scenario: Missing rate fails open for visibility

- **WHEN** an offer in GBP is extracted and no GBP rate exists
- **THEN** the offer row is written with null normalized columns, logged, still rolls up, and does not match RUB budget filters

### Requirement: Normalization is pure, replayable, and never mutates raw data

A pure `normalizeOffer()` function SHALL derive `priceRubMin`, `priceRubMax`, `fxRateUsed`, `fxAsOf`, `cpmRub`, `viewsBasis`, `viewsSource` from an offer row, a rate, and a views basis. RUB offers SHALL normalize with `fxRateUsed = 1`. Raw columns (`priceMin`, `priceMax`, `currency`, `rawPrice`, `rawSnippet`, `attributes`) SHALL never be modified by normalization or recompute.

#### Scenario: Normalized value is explainable

- **WHEN** an operator inspects a normalized price
- **THEN** the row shows which rate (`fxRateUsed`) effective when (`fxAsOf`) produced it

#### Scenario: Recompute touches only derived columns

- **WHEN** a rate changes and recompute runs
- **THEN** only the normalized columns change; raw columns and `capturedAt` are byte-identical before/after

### Requirement: Rate and views changes trigger bounded recompute of active rows

An `offer-renormalize` job SHALL recompute normalized columns when (a) a rate is upserted — for all `active` rows in that currency — and (b) a profile's post-insight refresh completes — for that profile's `active` rows' CPM. `superseded` and `low_confidence` rows SHALL never be recomputed (history keeps the normalization it had).

#### Scenario: Rate update renormalizes only the affected currency

- **WHEN** the USD rate is updated
- **THEN** active USD rows get new `priceRubMin/Max` and `fxAsOf`; RUB rows and superseded USD rows are untouched

### Requirement: CPM derives from platform post views with profile fallback

`cpmRub` SHALL be computed as `priceRubMin / views × 1000` where views resolve in order: median `views` of the newest ≤20 fresh `BloggerPostInsight` rows for the offer's platform; else `BloggerProfile.avgViews`; else null (no CPM). The basis number and its source (`post_insights` | `profile_avg`) SHALL be stored on the row. CPM SHALL be computed only for view-denominated kinds (post, story, reels, video, integration); `package`/`other` SHALL store null.

#### Scenario: Median of platform posts preferred

- **WHEN** a Telegram post offer is normalized for a profile with 20 fresh Telegram post insights
- **THEN** `cpmRub` uses the median views of those posts and `viewsSource = 'post_insights'`

#### Scenario: Package offers carry no CPM

- **WHEN** a `kind='package'` offer is normalized
- **THEN** `cpmRub` is null regardless of available views data

