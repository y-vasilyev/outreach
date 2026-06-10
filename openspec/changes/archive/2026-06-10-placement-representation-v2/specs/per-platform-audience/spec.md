## ADDED Requirements

### Requirement: Per-platform audience sizes are captured and comparable

The blogger profile SHALL carry a `platformAudience` collection — one entry per platform with `{ platform, subscribers, source, capturedAt }`. `AudienceStatsExtractor` SHALL emit `audience.subscribers.<platform>` data points for stated per-platform subscriber counts (it SHALL NOT silently discard subscriber counts as it did before), and the deterministic roll-up SHALL compose the latest-high-confidence count per platform into `platformAudience`. Subscriber counts SHALL remain distinct from `reach`/`avgViews` (which stay single scalars).

#### Scenario: Multi-platform subscriber line becomes per-platform audience

- **WHEN** a reply states «Инст 1.2млн, ТГ 15тыс, ВК 45тыс, ТикТок 24.5тыс подписчиков»
- **THEN** the profile's `platformAudience` has four entries (instagram 1200000, telegram 15000, vk 45000, tiktok 24500), instead of collapsing to one `reach`

#### Scenario: Subscriber count is not mistaken for reach

- **WHEN** a reply states a subscriber count for a platform
- **THEN** it lands in `platformAudience` for that platform and does not overwrite the `reach` scalar

#### Scenario: Catalog can compare two bloggers per platform

- **WHEN** the catalog list/compare view requests per-platform audience
- **THEN** the read API returns `platformAudience` so two bloggers can be ranked on the same platform's subscriber count
