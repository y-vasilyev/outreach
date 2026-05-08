## ADDED Requirements

### Requirement: Goal-fit evaluation agent

The system SHALL include a `GoalFitEvaluator` agent registered alongside the existing inbound-pipeline agents. The agent SHALL accept the latest N (≤ 8) messages of a conversation, the current `IntentClassifier` output, the current `HandoffDecider` output, the campaign's AJTBD framing, and the conversation's previous `qualityDecision` (for hysteresis). It SHALL return a structured object `{ score: number in [0,1], action: 'continue' | 'soften' | 'handoff_silent', reasons: string[] }`.

#### Scenario: Agent returns continue on a goal-aligned exchange
- **WHEN** the latest exchange aligns with the AJTBD's desired outcome and triggers no anti-goals
- **THEN** the agent returns `action = 'continue'` with `score ≥ T_auto_goalfit` and a non-empty `reasons` array citing observed alignment

#### Scenario: Agent returns soften on borderline drift
- **WHEN** the exchange is on-topic but is starting to drift from AJTBD desired outcome (e.g., sliding toward a non-goal without clearly hitting it)
- **THEN** the agent returns `action = 'soften'` with `score < T_auto_goalfit` but `score ≥ T_semi_auto_goalfit`

#### Scenario: Agent returns handoff_silent on clear violation
- **WHEN** the contact has shifted the conversation to one of the AJTBD `non_goals` (e.g., asking for ad placement during a CustDev interview)
- **THEN** the agent returns `action = 'handoff_silent'` with `score < T_semi_auto_goalfit` and reasons citing the violated non-goal

### Requirement: Pipeline placement of the gate

The gate SHALL run inside the `agent-run on_inbound` pipeline after `HandoffDecider` and after `ReplyComposer` has produced candidate drafts, so that the gate evaluates the conversation state alongside the actual draft to be sent. The gate SHALL be skipped when the conversation's mode is `manual` or `assisted`.

#### Scenario: Gate skipped in manual and assisted modes
- **WHEN** an inbound arrives on a conversation in `manual` or `assisted` mode
- **THEN** the `GoalFitEvaluator` agent is not invoked and no `qualityDecision` snapshot is updated

#### Scenario: Gate runs in semi_auto and auto modes
- **WHEN** an inbound arrives on a conversation in `semi_auto` or `auto` mode and `ReplyComposer` produced at least one safe draft
- **THEN** the gate is invoked exactly once per inbound, its decision is composed with safety and intent signals to determine auto-send eligibility, and its output is persisted as the latest `qualityDecision`

#### Scenario: Hard handoff short-circuits the gate
- **WHEN** `HandoffDecider` returns `action = 'operator_now'`
- **THEN** the gate is not invoked, the conversation is set to `assisted` (existing behavior), and `qualityDecision` is left untouched

### Requirement: Composition of gate, safety, and intent signals

The auto-approve decision SHALL combine the gate output with the existing safety check and conversation mode according to the following rule, evaluated per top-scored safe draft:

- `mode = semi_auto` requires `safety.allow && (1 - risk_score) ≥ T_safety && gate.action ∈ {continue, soften} && gate.score ≥ T_semi_auto_goalfit`.
- `mode = auto` requires the above with `gate.action == continue` and `gate.score ≥ T_auto_goalfit`.

#### Scenario: Semi-auto allows a softened reply to send
- **WHEN** in `semi_auto` mode the gate returns `action = 'soften'` with `score ≥ T_semi_auto_goalfit`, and safety clears
- **THEN** the draft is auto-approved and queued for send

#### Scenario: Auto mode rejects a softened reply
- **WHEN** in `auto` mode the gate returns `action = 'soften'`, even with `score` above all thresholds
- **THEN** the draft is NOT auto-sent; the best safe draft is persisted as a `pending` suggestion

### Requirement: Silent operator handoff on gate trip

When the conversation's mode is `auto` and the gate returns `handoff_silent`, the system SHALL: set `Conversation.mode` to `assisted`, persist the gate decision as `Conversation.qualityDecision`, leave the highest-scoring safe draft as a `pending` suggestion, emit a `quality.gate` realtime event to the operator room with `{ score, action, reasons, conversationId }`, and refrain from creating or queuing any outbound message or contact-visible artifact.

#### Scenario: Handoff produces no outbound and no contact-visible event
- **WHEN** the gate trips `handoff_silent` in `auto` mode
- **THEN** no `Message` row is created with `direction = 'out_'`, no `tg-send` job is enqueued, and no realtime event with the conversation as a topic is delivered to subscribers outside the operator room

#### Scenario: Operator UI receives the gate decision
- **WHEN** the gate trips `handoff_silent`
- **THEN** the operator room subscribed to that conversation receives a `quality.gate` event whose payload includes the score, action, and reasons

### Requirement: Hysteresis on handoff decisions

To suppress single-turn spurious handoffs, the system SHALL apply hysteresis: a `handoff_silent` action triggers a mode flip only when either (a) the gate has returned `handoff_silent` on the previous decision for this conversation as well, OR (b) the current `gate.score ≤ 0.3`. Per-campaign overrides MAY override this default.

#### Scenario: Single soft handoff does not flip mode
- **WHEN** the gate returns `handoff_silent` once with `score = 0.4` and the previous decision was `continue`
- **THEN** the conversation's mode is NOT flipped; the decision is recorded but the system continues in `auto` and emits the next inbound's draft as a `pending` suggestion (since `handoff_silent` on the current draft means the draft isn't safe-to-send)

#### Scenario: Two consecutive handoffs flip mode
- **WHEN** the gate returns `handoff_silent` twice in a row for the same conversation
- **THEN** the system flips the conversation to `assisted` on the second occurrence

#### Scenario: Severe single-turn fit failure flips immediately
- **WHEN** the gate returns `handoff_silent` with `score ≤ 0.3` on a single turn
- **THEN** the system flips the conversation to `assisted` without waiting for a second occurrence

### Requirement: Persistence and operator surfacing of gate decisions

The system SHALL persist the most recent gate decision per conversation as `Conversation.qualityDecision = { score, action, reasons, agentRunId, decidedAt }`. The operator-facing inbox SHALL surface this state in the conversation header and clear it whenever the operator manually changes mode.

#### Scenario: Latest decision is queryable
- **WHEN** an operator opens a conversation that has a recorded gate decision
- **THEN** `GET /conversations/:id` returns the `qualityDecision` field in the response payload

#### Scenario: Manual mode change clears the decision
- **WHEN** the operator changes a conversation's mode via `PATCH /conversations/:id`
- **THEN** `Conversation.qualityDecision` is cleared in the same transaction

### Requirement: Cost containment on gate execution

The gate SHALL only be invoked when the conversation mode is `semi_auto` or `auto`, SHALL receive at most 8 messages of context, and SHALL default to a low-cost LLM tier. Per-campaign overrides MAY raise the model tier or context size via `agentOverrides.goal_fit_evaluator`.

#### Scenario: Gate is not run for assisted-mode inbounds
- **WHEN** an inbound arrives on an `assisted` conversation
- **THEN** no `agent_run` row for `GoalFitEvaluator` is created and no LLM call is issued for the gate
