## ADDED Requirements

### Requirement: Sponsored-integration detector agent

The system SHALL include a `sponsored_integration_detector` agent that, given a list of a channel's recent posts (date + text), returns the subset classified as sponsored integrations. The agent SHALL emit only LLM-confirmed integrations — no regex-based or marker-based (`#реклама`, `erid=`) detection — and SHALL preserve the verbatim text snippet, optional brand, optional date, a confidence in [0,1], and a short rationale per detected integration. The agent SHALL run via `AgentRunner`, write `agent_run`, and persist its system/user prompts in `agent_config`.

#### Scenario: Detector returns only sponsored posts with verbatim snippets
- **WHEN** the agent receives 10 recent posts of which 2 are sponsored integrations
- **THEN** the agent returns exactly those 2 entries, each with the verbatim post snippet, a confidence ≥ the configured minimum, and a one-line rationale

#### Scenario: No sponsored posts — empty array, not fabrication
- **WHEN** the agent receives posts none of which read as sponsored
- **THEN** the agent returns an empty `integrations` array; it MUST NOT downgrade a non-sponsored post into a low-confidence "maybe" entry

#### Scenario: Brand is identified only when explicitly named in the post
- **WHEN** a sponsored post mentions a specific brand by name
- **THEN** the agent populates `brand` with that name; otherwise `brand` is omitted

### Requirement: Opener feed uses only detector output

The `agency_opening_composer` `observed_integrations` input SHALL be populated exclusively from the `sponsored_integration_detector` output, filtered by a configurable minimum confidence (default 0.6). The dispatcher first-message path and the `handleOutreachFirstMessage` path in `agent-run` SHALL both call the detector before invoking the opener; raw `channel.rawData.posts` SHALL NOT be passed through directly as `observed_integrations`.

#### Scenario: Detector returns confirmed integrations — opener cites them
- **WHEN** the detector flags one post as sponsored with confidence ≥ MIN_CONF and the dispatcher composes a first message
- **THEN** that flagged integration appears in the composer's `observed_integrations` input and the composer's no-fabrication guard treats it as a valid hook

#### Scenario: Detector returns no integrations — opener falls back to generic
- **WHEN** the detector returns zero integrations above MIN_CONF
- **THEN** the composer receives `observed_integrations: []` and its deterministic guard forces every variant to `auto_send_eligible = false`

#### Scenario: Detector call fails — opener treats as no integrations
- **WHEN** the detector throws or returns null
- **THEN** the opener is still invoked with `observed_integrations: []` and behaves as the no-integration case; the failure is logged but does not block the first-message path

### Requirement: Detector runs behind the agency-sourcing flag

The `sponsored_integration_detector` agent SHALL only be invoked when `getFeatureFlags().get('agency_sourcing')` is on and the campaign's type is `agency_sourcing`. When either gate is off, the detector is skipped and `observed_integrations` defaults to empty.

#### Scenario: Flag off — detector not called
- **WHEN** the `agency_sourcing` flag is off and a first-message dispatch runs for an `agency_sourcing` campaign
- **THEN** the detector is not invoked, the composer receives `observed_integrations: []`, and (per other gates) the agency opener is not selected anyway

#### Scenario: CustDev campaign — detector not called
- **WHEN** the campaign type is `custdev`
- **THEN** the detector is not invoked and the CustDev opener path is unchanged
