## ADDED Requirements

### Requirement: Matching stage-1 uses a SQL pre-cut with superset guarantee

Matching candidate selection SHALL apply a SQL pre-cut over `placement_offer` rows for brief conditions expressible as offer filters (platform, kind/format, budget via `priceRubMin`), then run the existing in-memory shortlist check unchanged over the pre-cut set. The pre-cut SHALL always be a superset of the final shortlist: conditions it cannot express safely are simply not applied at SQL level; profiles with zero active offer rows SHALL always be included (the legacy `rateCards` fallback evaluates them in memory); and with `structured_placement_offers` off the pre-cut SHALL not run at all (full scan as today). Final candidate sets and their order SHALL be identical to the full-scan implementation (regression-proven over seeded fixtures running both paths, including flag-off and legacy-only-profile fixtures).

#### Scenario: Pre-cut does not change match results

- **WHEN** the same brief is matched via the legacy full-catalog scan and via the SQL pre-cut path over identical data
- **THEN** the final ranked candidates are identical in membership and order

#### Scenario: Inexpressible conditions fall through to in-memory checks

- **WHEN** a brief constrains only topics (not expressible as an offer filter)
- **THEN** the pre-cut applies no offer-level narrowing and the in-memory shortlist performs the topic filtering as before

#### Scenario: Legacy-only profile is not excluded by the pre-cut

- **WHEN** a profile has legacy `rateCards` but no `placement_offer` rows and the brief sets a budget
- **THEN** the pre-cut still includes the profile and the in-memory shortlist evaluates its rate cards exactly as before
