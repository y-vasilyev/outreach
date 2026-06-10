## ADDED Requirements

### Requirement: placementOffers always populated from data points

`BloggerProfile.placementOffers` SHALL be populated from the profile's `placement.offer` data points on every roll-up, regardless of feature-flag state, so the catalog is structurally complete. The rolled-up `placementOffers` AND the legacy `rateCards`/`formats` derived for compatibility SHALL both apply the confidence-floor rule (facts below the configurable floor are excluded from these comparable views but retained as data points). Legacy `rateCards`/`formats` SHALL remain derived for compatibility above the floor.

#### Scenario: Profile exposes offers independent of flag

- **WHEN** a profile has confident `placement.offer` data points
- **THEN** the profile read response includes them in `placementOffers` whether or not `structured_placement_offers` is on

#### Scenario: Low-confidence offer excluded from comparable list but retained

- **WHEN** a profile has a `placement.offer` data point below the confidence floor
- **THEN** it is absent from `placementOffers` but still present (flagged needs-review) in the `dataPoints` provenance array
