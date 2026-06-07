## Purpose

Context-aware catalog triage for existing blogger profiles: operators can compare profiles against a campaign or advertising brief, inspect top public post evidence with metrics, and request asynchronous post insight refresh without making catalog reads perform upstream scraping.

## Requirements

### Requirement: Context-aware catalog fit
The blogger catalog SHALL support an optional fit context so operators can scan existing profiles against a current campaign goal or advertising brief. The catalog list API SHALL accept at most one of `campaignId` or `briefId`; when provided, each returned profile row SHALL include `fit` with `{ score, source, rationale, positiveSignals, gaps, evidencePostIds }`. The fit context SHALL be derived from persisted data: `briefId` loads the `AdBrief`; `campaignId` loads the campaign type goal, using AJTBD for `custdev` and the agency goal object for `agency_sourcing`. Catalog reads SHALL NOT call an LLM, ScrapeCreators, or Telegram inline.

#### Scenario: Catalog row includes campaign fit
- **WHEN** an operator opens the blogger catalog with a valid `campaignId`
- **THEN** each profile row includes a deterministic `fit` object explaining relevance to that campaign goal, or explicit gaps when the profile lacks enough data

#### Scenario: Catalog row includes brief fit from match context
- **WHEN** an operator opens the blogger catalog with a valid `briefId`
- **THEN** each profile row includes fit data derived from persisted match results when available, falling back to deterministic scoring without creating a new match run

#### Scenario: Invalid or ambiguous fit context is rejected
- **WHEN** a catalog request supplies both `campaignId` and `briefId`, or references a campaign with an invalid/missing goal
- **THEN** the API responds with a 400 and does not silently fall back to context-free scoring

#### Scenario: Context-free catalog remains compatible
- **WHEN** a catalog request supplies no `campaignId` or `briefId`
- **THEN** the API returns existing catalog rows without requiring or fabricating a `fit` object

### Requirement: Top-post previews in catalog rows
The blogger catalog SHALL expose a compact top-post preview for each profile when public post insight data exists. Each preview item SHALL include post identity, platform, URL when available, publish time, text snippet, media kind, metrics, metric capture time, source, freshness state, and a deterministic `performanceScore` used only for ordering. Missing platform metrics SHALL be represented as null/absent fields and SHALL NOT be inferred.

#### Scenario: Catalog shows top posts with metrics
- **WHEN** a profile has public post insights with views, reactions, or engagement metrics
- **THEN** the catalog row returns the highest-ranked preview posts with their source metrics and capture timestamps

#### Scenario: Catalog shows missing metrics honestly
- **WHEN** a profile has public post snippets but no reliable metrics for those posts
- **THEN** the preview still returns the post snippets with empty metrics and a visible freshness/availability state

#### Scenario: No post insights does not hide the profile
- **WHEN** a profile has no post insight rows
- **THEN** the catalog still returns the profile row and marks top-post preview as empty or unavailable

### Requirement: Operator triage controls
The catalog UI SHALL let operators sort and filter profiles by relevance, metric freshness, platform, topic, language, ad format, commercial readiness, and top-post performance while preserving the current table-first catalog workflow. Profile rows SHALL show enough inline evidence to decide whether to open the detail view: display name/social link, rate/format summary, reach or average views, fit score/rationale, top-post metric summary, and data freshness/gaps.

#### Scenario: Operator sorts by relevance
- **WHEN** an operator selects relevance sorting while a `campaignId` or `briefId` context is active
- **THEN** the catalog orders profiles by `fit.score` and still shows profiles with missing fit at the bottom with an explicit gap state

#### Scenario: Operator filters to profiles with usable post metrics
- **WHEN** an operator enables a "has top-post metrics" filter
- **THEN** only profiles with at least one non-stale post insight containing a numeric metric are shown

#### Scenario: Operator opens post evidence without losing catalog context
- **WHEN** an operator expands a row or opens a profile from a context-aware catalog
- **THEN** the UI preserves the active campaign/brief context and shows the same fit rationale and top-post evidence on the profile detail page

### Requirement: Explicit refresh path for post insights
The UI SHALL provide an operator action to request post insight refresh for a profile or channel. The action SHALL enqueue the relevant scrape/parse work and update the profile state asynchronously. It SHALL NOT perform upstream scraping inside the catalog read request.

#### Scenario: Operator requests post refresh
- **WHEN** an operator clicks refresh post metrics for a supported profile
- **THEN** the API enqueues the refresh work, returns accepted/pending status, and the catalog shows a pending enrichment state until the worker updates post insights

#### Scenario: Refresh is unavailable for unsupported source
- **WHEN** a profile has no supported public source for ScrapeCreators or Telegram parsing
- **THEN** the UI disables the refresh action and explains the missing supported source without creating a worker job
