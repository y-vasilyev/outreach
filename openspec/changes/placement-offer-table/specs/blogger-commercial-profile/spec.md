## ADDED Requirements

### Requirement: Rolled-up placement offers compose from offer rows

`BloggerProfile.placementOffers` SHALL be composed from `active` `placement_offer` rows, producing output byte-compatible with the legacy compose-from-data-points path (same shape, ordering, confidence floor). When a profile has no offer rows yet (pre-backfill window or dual-write incident override), composition SHALL fall back to the legacy data-point path and log which source was used.

#### Scenario: Catalog reads are unchanged after the switch

- **WHEN** the same extraction history is composed via offer rows and via the legacy data-point path
- **THEN** the resulting `placementOffers` arrays are equal (verified on the real failing-reply fixtures)

#### Scenario: Fallback before backfill

- **WHEN** a profile has `placement.offer` data points but no `placement_offer` rows
- **THEN** the roll-up composes from data points and records the fallback source

### Requirement: Profile read API exposes offer history

`GET /blogger-profiles/:id` SHALL expose, per offer identity, the `active` row id and its superseded chain (prior prices with `capturedAt` and provenance references), so an operator can see how a blogger's pricing changed over time without reading raw messages.

#### Scenario: Price history visible on the profile

- **WHEN** an offer was superseded twice by price updates
- **THEN** the profile response lists the active offer plus its two prior prices in reverse-chronological order with their captured timestamps
