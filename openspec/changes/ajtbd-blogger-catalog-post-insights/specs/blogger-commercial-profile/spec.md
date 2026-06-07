## ADDED Requirements

### Requirement: Public post insights attached to blogger profiles
The system SHALL store normalized public post insight rows for blogger profiles. Each row SHALL preserve public post identity, platform, URL when available, publish time, text snippet, media kind, source, metric capture time, and the metrics available from that source. Metrics MAY include views, likes, comments, shares, forwards, reactions, saves, and engagement rate. Missing metrics SHALL remain absent/null and MUST NOT be inferred from unrelated fields.

#### Scenario: ScrapeCreators post metrics are stored
- **WHEN** ScrapeCreators returns public Instagram or YouTube posts for a profile with metric fields available in the raw response
- **THEN** the worker normalizes those metrics into post insight rows linked to the blogger profile and preserves the capture timestamp/source

#### Scenario: Telegram public post metrics are stored
- **WHEN** Telegram public channel parsing yields a public post id, date, text, and metrics such as views, forwards, or reactions
- **THEN** the worker upserts a post insight row linked to the blogger profile and marks the source as Telegram public parsing

#### Scenario: Source lacks metrics
- **WHEN** a public post source provides text/date but no reliable metric values
- **THEN** the post insight row is stored with empty metrics rather than fabricating views, likes, or engagement

#### Scenario: Raw upstream payload is not exposed in profile API
- **WHEN** a profile detail response includes post insights
- **THEN** it exposes normalized public fields and provenance only, and does not include ScrapeCreators API keys, encrypted integration config, raw hidden data, or full upstream payloads

### Requirement: Profile APIs expose top post insights
The blogger profile list and detail APIs SHALL expose post insight data in bounded form. List responses SHALL include a compact `topPostsPreview` capped to a small number per profile. Detail responses SHALL include a larger `postInsights` collection with sorting metadata, metrics, freshness, and provenance. Existing profile fields SHALL remain backward compatible.

#### Scenario: List response includes bounded preview
- **WHEN** the catalog list API returns profiles with post insight rows
- **THEN** each profile item includes at most the configured preview count of top posts and does not include unbounded raw post history

#### Scenario: Detail response includes auditable post insights
- **WHEN** an operator opens a blogger profile detail page
- **THEN** the response includes post insights with post identity, metric values, metric freshness, source, and capture time

#### Scenario: Legacy profile without post insights remains readable
- **WHEN** a pre-existing profile has no post insight rows
- **THEN** the list and detail APIs still serialize successfully with empty post insight arrays

### Requirement: Post insight freshness is independent of profile freshness
Post insight metric freshness SHALL be calculated from each post insight's `metricCapturedAt` and SHALL NOT reuse profile-level `capturedAt` or commercial profile section freshness. The API SHALL expose whether post metrics are fresh, stale, unavailable, or pending refresh.

#### Scenario: Fresh post metrics are marked fresh
- **WHEN** a post insight has metrics captured within the configured post-metric TTL
- **THEN** the API marks that post's metric freshness as fresh and includes the age in days

#### Scenario: Stale post metrics are marked stale
- **WHEN** a post insight's metrics were captured before the configured TTL
- **THEN** the API marks that post's metric freshness as stale even if the profile's rate cards or audience sections are fresh

#### Scenario: Missing metric timestamp is unavailable
- **WHEN** a post insight has no metric capture timestamp or no numeric metrics
- **THEN** the API reports metric freshness as unavailable rather than fresh
