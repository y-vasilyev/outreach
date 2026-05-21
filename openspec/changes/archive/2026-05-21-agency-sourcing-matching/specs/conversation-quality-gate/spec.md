## MODIFIED Requirements

### Requirement: Goal-fit evaluation agent

The system SHALL include a `GoalFitEvaluator` agent registered alongside the existing inbound-pipeline agents. The agent SHALL accept the latest N (≤ 8) messages of a conversation, the current `IntentClassifier` output, the current `HandoffDecider` output, the campaign's goal object as defined by its campaign type (the AJTBD shape for `custdev`, the data-collection goal for `agency_sourcing`, or any other type's `goal_schema`), and the conversation's previous `qualityDecision` (for hysteresis). It SHALL return a structured object `{ score: number in [0,1], action: 'continue' | 'soften' | 'handoff_silent', reasons: string[] }`. The evaluator SHALL judge goal-fit and non-goal violations against the type's goal definition, not against a hardcoded CustDev/AJTBD assumption.

#### Scenario: Agent returns continue on a goal-aligned exchange
- **WHEN** the latest exchange aligns with the campaign goal's desired outcome and triggers no anti-goals
- **THEN** the agent returns `action = 'continue'` with `score ≥ T_auto_goalfit` and a non-empty `reasons` array citing observed alignment

#### Scenario: Agent returns soften on borderline drift
- **WHEN** the exchange is on-topic but is starting to drift from the goal's desired outcome (e.g., sliding toward a non-goal without clearly hitting it)
- **THEN** the agent returns `action = 'soften'` with `score < T_auto_goalfit` but `score ≥ T_semi_auto_goalfit`

#### Scenario: Agent returns handoff_silent on clear violation
- **WHEN** the contact has shifted the conversation to one of the goal's `non_goals` (e.g., for a `custdev` campaign asking for ad placement, or for an `agency_sourcing` campaign pushing the operator to commit money before review)
- **THEN** the agent returns `action = 'handoff_silent'` with `score < T_semi_auto_goalfit` and reasons citing the violated non-goal
