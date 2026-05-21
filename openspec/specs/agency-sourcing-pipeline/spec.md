## Purpose

The conversation pipeline for `agency_sourcing` campaigns: an agency-framed opening that cites a concrete observed integration in the blogger's posts, a `DataCollectionPlanner` that elicits target data points one topic at a time, and a commercial-language safety profile that permits ad vocabulary while still blocking guarantees, fabricated client specifics, money transfers, and forcing operator handoff on price commitments.

## Requirements

### Requirement: Agency-framed opening referencing the blogger's ad

For campaigns of type `agency_sourcing`, the system SHALL compose an opening message that presents the sender as a media-buying agency and references a concrete ad/integration observed in the blogger's own posts, framed as having a client interested in a similar placement. The opening SHALL ask to open a commercial conversation (price, formats, timelines) without committing to terms.

#### Scenario: Opening cites an observed ad
- **WHEN** the agency opening composer runs for a channel whose recent posts contain an identifiable sponsored integration
- **THEN** the generated opening references that integration as the hook and frames the message as an agency with a client seeking a similar placement

#### Scenario: Opening does not invent placements
- **WHEN** no sponsored integration can be identified in the channel's posts
- **THEN** the composer either uses the channel's topic as a generic agency hook or returns no auto-send-eligible variant, and SHALL NOT fabricate a specific past ad

### Requirement: Data-collection dialogue planner

For `agency_sourcing` conversations, the inbound pipeline SHALL run a `DataCollectionPlanner` that tracks which target data points (rate card per format, reach/views, audience demographics, geo, contact for deals) are still missing and proposes the next question to elicit them, one topic at a time.

#### Scenario: Planner asks for the next missing data point
- **WHEN** the blogger has shared pricing but not audience demographics
- **THEN** the planner proposes a reply that requests audience demographics and does not re-ask for pricing

#### Scenario: Planner stops when targets are collected
- **WHEN** all target data points for the campaign have been collected
- **THEN** the planner proposes a closing/thank-you reply and marks the conversation goal as satisfied

### Requirement: Commercial-language safety profile

The `agency_sourcing` safety profile SHALL permit commercial vocabulary (e.g. "реклама", "интеграция", "прайс", "охваты") while still blocking: guarantees of results, fabricated client specifics, transfers of money or payment links, and pressure tactics. Intents indicating price agreement or sending a quote SHALL force operator handoff so a human confirms commercial terms.

#### Scenario: Commercial vocabulary passes safety
- **WHEN** an agency-mode draft mentions "интеграция" and asks for the blogger's "прайс"
- **THEN** `SafetyFilter` does not block the draft on vocabulary grounds

#### Scenario: Price commitment forces handoff
- **WHEN** the blogger states a price and the intent classifier flags a price-agreement/quote intent
- **THEN** the conversation is set to `operator_now`/`manual` and no auto-send occurs for that turn

#### Scenario: Result guarantees are still blocked
- **WHEN** an agency-mode draft promises a specific result (e.g. guaranteed sales or views)
- **THEN** `SafetyFilter` blocks the draft and supplies a rewrite hint
