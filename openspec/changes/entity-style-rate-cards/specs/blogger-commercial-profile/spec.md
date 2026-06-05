## ADDED Requirements

### Requirement: Blogger profile surfaces structured placement offers
The blogger profile read API SHALL include `placementOffers` alongside legacy `rateCards`. Each placement offer SHALL expose typed attributes, price/currency, confidence, source message id, raw snippet, and captured timestamp. Existing `rateCards` and `formats` SHALL continue to be present and SHALL be derived from placement offers when structured data exists.

#### Scenario: Profile detail includes offer attributes
- **WHEN** a profile contains a Telegram post offer for one month and an offsite review offer
- **THEN** the profile detail response includes both structured offers with their attributes and also includes compatibility `rateCards`

#### Scenario: Legacy rows are repaired from source message
- **WHEN** a profile only has generic legacy rows but their source message can be loaded
- **THEN** the read service derives structured placement offers from the source message and uses them to produce non-collapsed compatibility rate cards

### Requirement: Placement offer provenance is auditable
Each placement offer and attribute SHALL retain source provenance back to the original message/media-kit payload and the extractor run. The raw text fragment used for the offer or attribute SHALL be available in the profile detail response.

#### Scenario: Operator audits extracted duration
- **WHEN** an operator opens a placement offer with `duration=month`
- **THEN** the UI can show the raw snippet containing "пост на месяц 21000" and link back to the source message

### Requirement: Profile freshness includes placement offers
The profile freshness signal SHALL classify usable structured placement offers as contributing to the `rateCards` and `formats` freshness sections. Missing or inactive attribute proposals SHALL NOT mark a placement target as complete.

#### Scenario: Fresh structured offer updates rate-card freshness
- **WHEN** a placement offer with a usable price was captured within the rate-card TTL
- **THEN** `freshness.rateCards` and `freshness.formats` are fresh even if no legacy `rate.<format>` data point was written directly

#### Scenario: Proposed attribute does not complete active profile field
- **WHEN** an extractor proposes an inactive attribute for an offer
- **THEN** the profile may show the proposal for review, but the attribute is not counted as collected until activation
