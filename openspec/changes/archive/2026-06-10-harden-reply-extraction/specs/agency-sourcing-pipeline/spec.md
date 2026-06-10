## ADDED Requirements

### Requirement: Structured placement offers are the canonical write path

For `agency_sourcing` conversations, the inbound profile-extract pipeline SHALL **always** persist structured `placement.offer` data points, `placement_attribute` proposals, and roll them up onto `BloggerProfile.placementOffers`, independent of any feature flag. The `structured_placement_offers` feature flag SHALL govern only downstream **matching and data-collection-planner preference** (whether fit-scoring and the planner prefer structured offers over legacy `rate.<format>` cards) — it SHALL NOT gate whether structured offers are persisted, rolled up, or exposed by the profile read API (which already returns `placementOffers` unconditionally). Legacy `rate.<format>` data points SHALL continue to be derived for compatibility.

#### Scenario: Offers persisted and exposed with flag off

- **WHEN** an inbound reply yields placement offers and `structured_placement_offers` is off
- **THEN** the `placement.offer` data points and attribute proposals are persisted, `BloggerProfile.placementOffers` is rolled up, and the profile read API exposes them — while fit-scoring and the planner still use the legacy path

#### Scenario: Flag governs matching/planner preference only

- **WHEN** `structured_placement_offers` is turned on
- **THEN** fit-scoring and the planner prefer the already-persisted structured offers; turning the flag on does not require re-running extraction to populate them

### Requirement: Deterministic parser covers common Russian reply layouts

The deterministic placement-offer parser SHALL, without any schema change, recognise: a `млн`/`млрд` price multiplier; the platforms `МАХ`/MAX, `Дзен`/Zen, and `ТГК` (mapped to the promoted `platform` field as `max`/`zen`/`telegram`); comma-separated per-format price pairs on a single line; and placement-duration ladders (`час топа`/`72ч`) as separate offers whose precise tier is preserved in the free-form `notes` attribute when it does not fit the existing duration values.

#### Scenario: Millions parsed in audience/price prose

- **WHEN** a reply contains `"1.2млн"`
- **THEN** the parser yields the numeric value `1200000`, not `1.2`

#### Scenario: Non-enum platforms preserved

- **WHEN** a reply prices placements on `ТГК` and `МАХ`
- **THEN** the offers carry `platform = "telegram"` and `platform = "max"` respectively, instead of dropping the second platform

#### Scenario: Comma-separated per-format pair on one line

- **WHEN** a line reads `"Фото-пост 120000, Видео-пост 170000"`
- **THEN** the parser yields two offers, one per format with its own price

#### Scenario: Duration ladder preserved in notes

- **WHEN** a line reads `"Час топа/24ч 6000, /72ч 9000, /месяц 12000"`
- **THEN** the parser yields three offers and the `72ч` tier is preserved (e.g. in a `notes` attribute) rather than discarded
