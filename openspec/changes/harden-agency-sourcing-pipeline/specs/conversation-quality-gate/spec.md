## MODIFIED Requirements

### Requirement: Goal-fit evaluation agent

The system SHALL include a `GoalFitEvaluator` agent registered alongside the existing inbound-pipeline agents. The agent SHALL accept the latest N (≤ 8) messages of a conversation, the current `IntentClassifier` output, the current `HandoffDecider` output, the campaign's goal object as defined by its campaign type (the AJTBD shape for `custdev`, the data-collection goal for `agency_sourcing`, or any other type's `goal_schema`), the campaign's `type.key` and `type.goalIntent` (when available), and the conversation's previous `qualityDecision` (for hysteresis). It SHALL return a structured object `{ score: number in [0,1], action: 'continue' | 'soften' | 'handoff_silent', reasons: string[] }`.

The agent SHALL judge goal-fit and non-goal violations against the type's goal definition, not against a hardcoded CustDev/AJTBD assumption. The agent's prompt SHALL branch on the campaign type's `goalIntent`:
- For `custdev` (or `goalIntent === 'research_interview'`) — current CustDev framing: ad-sales drift is a non-goal.
- For `agency_sourcing` (or `goalIntent === 'collect_commercial_data'`) — goal alignment means the conversation is progressing toward eliciting one of the type's `target_data_points` (price, reach, audience, geo); non-goals include the operator committing money before review, fabricating client details, or guaranteeing results.
- For other types — the agent uses the type's `goalIntent` plus `goalSchema` to construct the goal frame; no CustDev assumptions.

The `extractAjtbdView` helper SHALL produce a goal scaffold appropriate for the campaign's type. For non-custdev types it SHALL include the type's `goalSchema`-derived fields (e.g. `target_data_points` for agency) in addition to the legacy `goalText`/`valueProp`-derived scaffold.

#### Scenario: Agent returns continue on a goal-aligned exchange (CustDev)
- **WHEN** a `custdev` conversation's latest exchange aligns with the research-interview goal and triggers no anti-goals
- **THEN** the agent returns `action = 'continue'` with `score ≥ T_auto_goalfit` and reasons citing observed alignment

#### Scenario: Agent returns continue on a goal-aligned exchange (Agency)
- **WHEN** an `agency_sourcing` conversation's latest exchange shows the blogger sharing pricing or reach data and the agent identifies progress toward `target_data_points`
- **THEN** the agent returns `action = 'continue'` with `score ≥ T_auto_goalfit` and reasons citing the collected data point

#### Scenario: Agent returns soften on borderline drift
- **WHEN** the exchange is on-topic but is starting to drift from the goal's desired outcome (e.g., sliding toward a non-goal without clearly hitting it)
- **THEN** the agent returns `action = 'soften'` with `score < T_auto_goalfit` but `score ≥ T_semi_auto_goalfit`

#### Scenario: Agent returns handoff_silent on clear violation (CustDev)
- **WHEN** a `custdev` contact asks for ad placement / wants payment for ads
- **THEN** the agent returns `action = 'handoff_silent'` with `score < T_semi_auto_goalfit` and reasons citing the CustDev non-goal

#### Scenario: Agent returns handoff_silent on clear violation (Agency)
- **WHEN** an `agency_sourcing` contact pushes the operator to wire money or commit terms before review
- **THEN** the agent returns `action = 'handoff_silent'` with `score < T_semi_auto_goalfit` and reasons citing the agency-specific non-goal (premature commitment / payment)

#### Scenario: extractAjtbdView builds the agency scaffold
- **WHEN** the gate is invoked for an `agency_sourcing` campaign whose goal contains `target_data_points: ['rate_card','reach']`
- **THEN** `extractAjtbdView` returns a scaffold that carries those target data points to the evaluator, and the evaluator's prompt input includes them; the CustDev `desired_outcomes`/`non_goals` lists from a legacy CustDev template are NOT used
