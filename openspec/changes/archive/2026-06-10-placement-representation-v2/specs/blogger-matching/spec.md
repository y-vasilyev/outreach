## ADDED Requirements

### Requirement: Matching can compare on v2 representation

Brief matching SHALL be able to use per-platform audience and the v2 placement terms (`price_period`, `prepayment`, `tax_regime`) when scoring and summarizing candidates, without regressing the legacy rate-card fallback. When a brief targets a specific platform, candidate ranking SHALL be able to use that platform's `platformAudience` subscriber count. For budget fit, when an offer carries multiple `price_period` variants for the same format, matching SHALL use the `base` price (falling back to `seasonal`/`promo` only when no `base` exists), so a temporary markup does not wrongly fail a candidate. Structured v2 matching SHALL remain behind the existing `structured_placement_offers` preference flag (default off); this change SHALL NOT alter that default. The shared matchable profile, the API match serialization, and the web profile type SHALL all carry `platformAudience` so it reaches ranking and display.

#### Scenario: Per-platform audience informs ranking

- **WHEN** a brief targets Telegram and two candidates differ in Telegram subscriber count
- **THEN** matching can rank the larger Telegram audience higher using `platformAudience`, not a blended scalar

#### Scenario: Seasonal price does not distort budget fit

- **WHEN** an offer is marked `price_period = seasonal`
- **THEN** matching can prefer the `base` price for budget comparison so a temporary seasonal markup does not wrongly fail a candidate
