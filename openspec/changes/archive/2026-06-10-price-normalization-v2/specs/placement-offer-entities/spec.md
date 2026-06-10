## ADDED Requirements

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
