## MODIFIED Requirements

### Requirement: Pipelines resolve behavior from the campaign type

The `outreach_first_message`, `on_inbound`, and `followup_check` pipelines SHALL resolve which agents to run, their prompts/config, the safety profile, and the autonomy policy from the conversation's campaign type rather than from hardcoded CustDev constants.

Every outbound-producing path (dispatcher first-message, `agent-run` `handleOutreachFirstMessage`, `agent-run` `on_inbound` reply, `apps/api/src/services/conversations.ts` operator-approve and direct-send) SHALL invoke `SafetyFilter` with the FULL safety input derived from the campaign's type — `allowed_topics`, `forbidden_topics`, `hard_block_patterns`, `max_length`, `allow_links` — via a single shared helper `buildSafetyInput(campaign, draft, ctx)`. No path SHALL pass a partial safety input (e.g. only `hard_block_patterns`) when a type-attached profile is available.

For campaigns without a type, or when the `campaign_types` flag is off, the helper SHALL return the legacy SafetyFilter input shape (empty arrays, no overrides) so behavior is byte-for-byte identical to the pre-registry path.

#### Scenario: Inbound pipeline uses the type's agent set and safety profile
- **WHEN** an inbound arrives on a conversation whose campaign is type `agency_sourcing`
- **THEN** the pipeline runs the agency type's configured agents and `SafetyFilter` uses the agency `safety_profile`, not the global CustDev defaults

#### Scenario: CustDev behavior is preserved through the registry
- **WHEN** an inbound arrives on a conversation whose campaign is type `custdev`
- **THEN** the pipeline runs the same agents and applies the same forbidden-vocabulary safety rules as before this change

#### Scenario: Dispatcher passes full safety input
- **WHEN** the dispatcher invokes `SafetyFilter` on an agency-campaign first-message variant
- **THEN** the input contains `allowed_topics`, `forbidden_topics`, `hard_block_patterns`, `max_length`, and `allow_links` from the type's safety profile — not just `hard_block_patterns`

#### Scenario: Operator approve passes full safety input
- **WHEN** an operator clicks "Approve" on a draft for an `agency_sourcing` conversation
- **THEN** the API runs `SafetyFilter` with the same full safety input the dispatcher would have used; a draft that newly violates `forbidden_topics` is rejected with the same error shape as the dispatcher path

#### Scenario: Direct-send passes full safety input
- **WHEN** an operator submits a direct-send message for an `agency_sourcing` conversation
- **THEN** the API runs `SafetyFilter` with the full safety input; pre-change behavior (no safety profile applied) is removed

#### Scenario: Type-less campaign falls back to legacy shape
- **WHEN** a campaign has no `type` set or the `campaign_types` flag is off
- **THEN** `buildSafetyInput` returns the legacy SafetyFilter input (empty overrides) and the SafetyFilter call is byte-for-byte the pre-registry shape

## ADDED Requirements

### Requirement: SafetyFilter input parity is testable across call sites

The codebase SHALL expose a single helper `buildSafetyInput(args)` and SHALL have a regression test that exercises all SafetyFilter call sites (dispatcher first-message, agent-run inbound reply, agent-run first-message, operator approve, direct send) with the same campaign + draft and asserts the SafetyFilter input object is structurally identical across sites.

#### Scenario: All call sites produce identical SafetyFilter input
- **WHEN** the regression test runs each call site with a fixed agency campaign and a fixed draft text
- **THEN** the SafetyFilter input passed by each site has the same keys, the same `allowed_topics`/`forbidden_topics`/`hard_block_patterns`/`max_length`/`allow_links` values, and no site silently drops a field
