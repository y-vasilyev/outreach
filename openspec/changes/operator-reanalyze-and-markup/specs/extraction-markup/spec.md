## ADDED Requirements

### Requirement: Operator corrections to profile data points

`POST /blogger-profiles/:id/data-points` SHALL create an operator-origin data point (`extractedBy='operator'`, `confidence=1.0`) for a given field/value, and `DELETE /blogger-profiles/:id/data-points/:dpid` SHALL remove a data point. The write SHALL be FIELD-AWARE: the accepted `field`s and their value shapes are constrained to what the roll-up actually consumes (numeric for `reach`/`avgViews`/`rate.<format>` — coerced via the shared price normalizer; a validated `PlacementOffer` for `placement.offer`; a label→share record for `audience.geo|age|gender`; a number for `audience.subscribers.<platform>`), so an operator cannot write a value the roll-up would silently drop. The deterministic roll-up SHALL prefer the operator point (highest confidence wins), and the profile SHALL be re-rolled after either call. The profile read SHALL expose each point's origin (`extractedBy`) so the operator can tell machine from human values. Only operators/admins may write/delete. (HUD `manual_only` target semantics are unchanged by this change — operator points flow through the roll-up like any data point.)

#### Scenario: Operator fixes a wrong value

- **WHEN** an operator writes an operator-origin `reach` of 50000 over a machine-extracted 5000
- **THEN** the rolled-up profile `reach` becomes 50000 (operator confidence 1.0 wins) and the point is marked origin=operator

#### Scenario: Operator deletes a wrong machine point

- **WHEN** an operator deletes a mis-extracted `rate.story` point
- **THEN** it is removed and the profile re-rolls without it

### Requirement: Operator hints consumed by extractor agents

An `extraction_hint` SHALL hold operator guidance scoped `global|channel|conversation`, an optional `targetField`, free-text `guidance`, and optional few-shot `exampleInput`/`exampleOutput`. The profile-extract worker SHALL load the hints applicable to the message's channel/conversation and pass them to the extractor agents as `operator_hints`, which SHALL render them into the prompt as ADVISORY parsing rules — never as evidence. The rendered block SHALL be fenced and labelled as operator hints, the count and length SHALL be capped (≤10 hints, ≤500 chars each), and the prompt SHALL instruct the extractor to still emit ONLY facts present in the source text (a hint steers interpretation, it does not license inventing prices/reach). Hints are consumed by the read-only extractor agents only — never by the outbound composer — so they cannot affect what is sent to a blogger. Hints SHALL be CRUD-managed by operators/admins.

#### Scenario: A channel hint changes the next extraction

- **WHEN** a `channel`-scoped hint says «МАХ here means the MAX messenger, map platform=max» and a new reply mentions МАХ
- **THEN** the extractor receives the hint in `operator_hints` and is steered to map the platform correctly

#### Scenario: Hints are scoped

- **WHEN** extraction runs for a conversation
- **THEN** only `global` hints, hints for that channel, and hints for that conversation are passed — not hints scoped to other channels/conversations
