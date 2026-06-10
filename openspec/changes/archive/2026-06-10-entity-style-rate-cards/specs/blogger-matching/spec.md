## ADDED Requirements

### Requirement: Matching can use structured placement attributes
The blogger matching system SHALL use structured placement offers when available to evaluate format, platform, duration, deletion policy, included deliverables, tax terms, and price constraints. If structured offers are absent, matching SHALL fall back to legacy `rateCards`.

#### Scenario: Brief requires long-lived Telegram post
- **WHEN** a brief asks for a Telegram post that remains for a month or longer
- **THEN** matching ranks profiles with `platform=telegram`, `kind=post`, and `duration=month` or equivalent deletion policy above profiles that only offer a one-day post

#### Scenario: Matching falls back to legacy rates
- **WHEN** a profile has no structured placement offers but has legacy `rateCards`
- **THEN** matching continues to score the profile using the legacy rate-card behavior

### Requirement: Matching explains structured placement fit
When a match score depends on structured placement attributes, the system SHALL include those attributes in the match rationale so an operator can verify why a profile was selected or penalized.

#### Scenario: Rationale cites placement terms
- **WHEN** a candidate is selected because it offers an offsite review that includes a permanent post and event announcement
- **THEN** the match rationale mentions those placement terms rather than only the synthetic rate-card format
