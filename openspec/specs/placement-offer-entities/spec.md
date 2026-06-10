# placement-offer-entities Specification

## Purpose
TBD - created by archiving change entity-style-rate-cards. Update Purpose after archive.
## Requirements
### Requirement: Structured placement offers
The system SHALL represent each commercial placement offer as a structured object with at least `kind`, `price`, `currency`, `attributes`, `confidence`, `rawSnippet`, and source provenance. Known attributes SHALL be typed and keyed, including `platform`, `duration`, `delete_policy`, `includes`, `tax`, and `notes` where present. The offer SHALL preserve the original source snippet so an operator can audit every extracted term.

#### Scenario: Inline quote becomes multiple placement offers
- **WHEN** a blogger replies "пост на сутки 13000, пост на месяц 21000 + налог 6%" and also mentions an offsite review for 30000
- **THEN** the extractor emits separate placement offers for the day post, month post, and offsite review, each with its own price, attributes, confidence, and raw source snippet

#### Scenario: Tax term is an attribute, not a price row
- **WHEN** a quote includes "налог 6%" next to a placement price
- **THEN** the system stores the tax detail as a tax attribute or unresolved tax note on the relevant offer and SHALL NOT create a separate rate-card price for the tax percentage

### Requirement: Placement attribute registry
The system SHALL maintain an active placement attribute registry that defines each known attribute's key, value type, description, applicable placement kinds, and requiredness. Extraction and planning SHALL validate active attributes against this registry before treating them as collected facts.

#### Scenario: Active attribute validates extractor output
- **WHEN** an extractor emits `duration = month` for a `post` placement and the registry defines `duration` as an allowed enum attribute for posts
- **THEN** the output is accepted as a typed placement attribute with provenance

#### Scenario: Unknown active attribute is not silently accepted
- **WHEN** an extractor emits an attribute key that is absent from the active registry
- **THEN** the system stores it as an attribute proposal or review note and SHALL NOT treat it as an active collected attribute

### Requirement: Controlled attribute proposals
The system SHALL allow LLM extraction to propose new placement attributes when source text contains commercially relevant terms that are not covered by the active registry. A proposal SHALL include suggested key, value type, placement kind applicability, evidence snippets, confidence, and rationale. Proposed attributes SHALL remain inactive until approved by an operator/config rule.

#### Scenario: New attribute proposal is created
- **WHEN** the extractor sees a recurring term such as a deletion policy that is not in the active registry
- **THEN** it creates an inactive attribute proposal with evidence and does not mutate the active registry directly

#### Scenario: Approved proposal becomes usable
- **WHEN** an operator approves an attribute proposal
- **THEN** future extraction and planning runs can use that attribute as an active typed field

### Requirement: Legacy rate-card compatibility roll-up
The system SHALL derive legacy `RateCard` rows from structured placement offers while legacy catalog and matching paths still depend on `rateCards`. The derived format key SHALL be deterministic from stable offer attributes such as platform, kind, and duration, but the structured offer SHALL remain the source of truth for commercial terms.

#### Scenario: Structured offer produces compatibility rate card
- **WHEN** a placement offer has `kind=post`, `platform=telegram`, `duration=month`, and `price=21000 RUB`
- **THEN** the compatibility roll-up includes a rate card such as `telegram_post_month` for existing consumers

#### Scenario: Two same-kind offers remain distinct
- **WHEN** a profile has both a day post and month post offer
- **THEN** the structured offers and compatibility rate cards retain both prices rather than collapsing to one `post` value

### Requirement: Tolerant per-element extraction validation

Extractor output validation SHALL be per-element, not whole-payload. When the model returns the `{ data_points, placement_offers, attribute_proposals }` object, each element of each array SHALL be validated independently; an element that fails validation SHALL be dropped with a logged warning (`{ event, conversationId, sourceMessageId, reason }`) while every valid sibling element is retained. A single malformed element MUST NOT cause the loss of the other facts extracted from the same message.

#### Scenario: One malformed offer does not lose the message

- **WHEN** the extractor returns three placement offers and one has an invalid field (e.g. a non-coercible price)
- **THEN** the two valid offers are persisted and the invalid one is dropped with a logged warning, rather than the whole payload being rejected

#### Scenario: Mixed valid/invalid across arrays

- **WHEN** `data_points` contains a valid rate point and `attribute_proposals` contains one malformed proposal
- **THEN** the valid rate point is persisted and only the malformed proposal is dropped

### Requirement: Price coercion in placement-offer validation

Placement-offer and rate data-point price validation SHALL coerce common Russian price phrasings to a number rather than reject them: `"от 118000"`, `"118 000"` (thin/regular spaces), `"1.2млн"`/`"1,2 млн"`, `"50к"`/`"50 тыс"`. When a price token cannot be coerced to a finite non-negative number the offer SHALL still be retained with `price = null` (term-only offer) rather than dropped.

#### Scenario: "от" prefix and spaces coerced

- **WHEN** an offer price is the string `"от 118 000"`
- **THEN** the offer validates with `price = 118000`

#### Scenario: Millions multiplier coerced

- **WHEN** an offer price is the string `"1.2млн"`
- **THEN** the offer validates with `price = 1200000`

### Requirement: Multiple tax attributes per offer

A placement offer SHALL support more than one `tax` attribute so stacked taxes are not collapsed. When a reply states two distinct taxes (e.g. `"налог 8% ИП"` and `"доп налог на рекламу 3%"`), both SHALL be emitted as separate `tax` attributes on the relevant offer(s), each with its own verbatim `rawSnippet`. Consumers that summarize taxes (e.g. matching `placement_terms`) SHALL read ALL `tax` attributes via a repeatable-attribute accessor, not only the first.

#### Scenario: Two taxes both captured

- **WHEN** a reply states `"Налог 8% ИП включён. Доп налог на рекламу 3%"`
- **THEN** the offer carries two `tax` attributes, one per stated tax, neither overwriting the other

#### Scenario: Matching surfaces all taxes

- **WHEN** an offer with two `tax` attributes is summarized for matching
- **THEN** both taxes appear in the placement terms, not just the first

### Requirement: Confidence-floor on all comparable commercial views

The rolled-up comparable commercial views SHALL exclude facts whose confidence is below a configurable floor (default 0.2). This applies to BOTH `BloggerProfile.placementOffers` AND the legacy `rateCards`/`formats` derived from `rate.<format>` data points, so a sub-floor fact cannot leak into the comparable catalog via the legacy path. Excluded facts SHALL NOT be deleted — their data-point rows persist with provenance and SHALL be retrievable as needs-review items. Exclusion is presentation-level only; it never removes harvested facts, and HUD/observation freshness continues to reflect raw observations regardless of the floor.

#### Scenario: Garbled low-confidence offer kept but not shown in comparable view

- **WHEN** an extracted offer has confidence 0.1
- **THEN** it is persisted as a data point flagged needs-review but does not appear in the rolled-up `placementOffers` used for search/compare

#### Scenario: Sub-floor fact does not leak via legacy rate cards

- **WHEN** a sub-floor structured offer would derive a legacy `rate.<format>` card, and no above-floor point supports that format
- **THEN** the derived `rateCards`/`formats` comparable view also omits it

#### Scenario: Confident offer appears in comparable view

- **WHEN** an extracted offer has confidence 0.9
- **THEN** it appears in the rolled-up `placementOffers`

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

### Requirement: Extractors emit price ranges without coercing approximations

The placement-offer extraction contract (`PlacementOfferDraftZ`, deterministic parsers, and the LLM prompt) SHALL support optional `price_min`/`price_max`: «5–7к» → 5000/7000; «от 118 000» → min=118000, max=null; exact price → min=max; no price → both null (term-only). The legacy `price` field SHALL remain equal to `price_min` so existing dedupe keys, format derivation, and consumers are unchanged. Range multipliers SHALL distribute across both bounds («5–7к» = 5000–7000, not 5–7000). Drafts where both `price` and `price_min` are present SHALL be rejected by validation unless equal.

#### Scenario: Dash range parsed deterministically

- **WHEN** a reply states «пост 5-7к»
- **THEN** the draft carries `price_min=5000`, `price_max=7000`, `price=5000`, and the verbatim text in `rawSnippet`

#### Scenario: «от»-price stays open-ended

- **WHEN** a reply states «от 118 000»
- **THEN** the draft carries `price_min=118000`, `price_max=null` and is not represented as an exact 118000 anywhere downstream except `price` (= min, for compatibility)

#### Scenario: «до»-price bounds from above

- **WHEN** a reply states «до 30к»
- **THEN** the draft carries `price_min=null`, `price_max=30000`

