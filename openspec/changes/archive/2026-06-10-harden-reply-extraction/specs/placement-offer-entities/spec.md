## ADDED Requirements

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
