## ADDED Requirements

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
