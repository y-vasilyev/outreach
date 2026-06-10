## ADDED Requirements

### Requirement: Profile exposes platformAudience and v2 placement terms

The blogger profile read API SHALL include `platformAudience` and SHALL preserve the v2 placement attributes (`price_period`, `prepayment`, `tax_regime`, `tax_included`, `tariff_name`, `slot`, `top_pin_hours`, `package_items`, `package_price`) on each offer, so operators and the compare view can inspect them without parsing free text. Legacy `reach`/`avgViews`/`audience`/`rateCards` SHALL remain populated and unchanged.

#### Scenario: Read API returns per-platform audience

- **WHEN** a profile has `platformAudience` entries
- **THEN** the profile detail response includes them alongside the legacy scalar `reach`

#### Scenario: v2 attributes survive the roll-up onto the read model

- **WHEN** an offer carries `price_period`/`prepayment`/`tax_regime`
- **THEN** those attributes appear on the offer in the profile read response
