## ADDED Requirements

### Requirement: Registry v2 attribute keys

The active placement attribute registry SHALL include these additional keys so common commercial terms have a typed, comparable home instead of free-form `notes`: `tariff_name` (string), `slot` (string), `price_period` (enum `base|seasonal|promo`), `prepayment` (string), `tax_regime` (enum `ip|self_employed|ooo|none`), `tax_included` (boolean), `top_pin_hours` (number), `package_items` (string_list). All nine keys SHALL have `requiredForKinds: []` so they never introduce new data-collection-planner follow-ups by default. Package totals SHALL stay on the offer itself (`kind=package` + `offer.price`); `package_items` only lists the bundle composition (no separate `package_price`). These are additive — existing keys and the extraction/proposal/review flow are unchanged, and an unknown key still routes to a proposal.

#### Scenario: v2 keys do not change planner behavior by default

- **WHEN** the v2 registry is active and a campaign has not opted any v2 key into `requiredForKinds`
- **THEN** `missingRequiredAttributes` returns the same set as before and the planner asks no new follow-ups

#### Scenario: Seasonal price marked, not overwritten

- **WHEN** a reply quotes a base price and a «Цена июня» price for the same format
- **THEN** the two offers carry `price_period = base` and `price_period = seasonal` respectively and both are retained

#### Scenario: Prepayment and tax regime are typed

- **WHEN** a reply states «ИП, 100% предоплата, налог включён»
- **THEN** the offer carries `tax_regime = ip`, `prepayment = "100%"`, and `tax_included = true`

### Requirement: Named tariffs and slots stay distinct without changing format keys

Offers that differ by `tariff_name` or `slot` SHALL NOT collapse during roll-up. This SHALL be achieved by adding `tariff_name`/`slot` to the OFFER dedupe key (`collectPlacementOffers` and the extractor's `pushOffer`), NOT by changing `derivePlacementFormatKey`. The derived `rate.<format>` keys, the `formats` union, catalog filters, and web labels SHALL remain byte-identical to today when no tariff/slot is present (no tariff/slot text leaks into format strings).

#### Scenario: Two same-price slots stay distinct

- **WHEN** two offers share platform/kind/duration/price but carry `slot=1` vs `slot=2`
- **THEN** both are retained as distinct offers after roll-up (the dedupe key separates them)

#### Scenario: Format keys unchanged when no slot/tariff

- **WHEN** an offer carries no `tariff_name`/`slot`
- **THEN** its derived `rate.<format>` key is identical to the pre-change output
