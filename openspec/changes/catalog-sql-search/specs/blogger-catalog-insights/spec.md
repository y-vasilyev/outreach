## ADDED Requirements

### Requirement: Catalog filter bar drives server-side offer filters

The catalog UI SHALL expose controls for platform, kind, max price (₽), max CPM, offer freshness, and sort mode that map to the `GET /blogger-profiles` offer-search params and refetch from the server. Free-text/topic search SHALL remain client-side; no facet SHALL be filtered both client- and server-side. Rows and the compare view SHALL render normalized prices/CPM with their staleness badges and fx/views-basis hints.

#### Scenario: Filter change refetches from the server

- **WHEN** the operator sets «до 50 000 ₽» and «Telegram»
- **THEN** the catalog refetches with the corresponding query params and shows only server-matched profiles

#### Scenario: Compare shows normalized values with provenance hints

- **WHEN** two bloggers are compared and one has a stale USD-derived price
- **THEN** the compare panel shows its ₽ value with the rate date hint and a stale badge alongside the fresher competitor
