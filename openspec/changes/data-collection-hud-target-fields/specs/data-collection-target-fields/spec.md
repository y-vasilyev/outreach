## ADDED Requirements

### Requirement: Typed registry of data-collection target fields

The system SHALL ship a typed registry of data-collection target fields in `packages/shared` keyed by a stable string key. Each registry entry SHALL declare `{ key, label, description_for_operator, description_for_agent, question_template, freshness_section, profile_data_point_keys[], manual_only? }`. `freshness_section` SHALL be one of the sections returned by the existing `computeProfileFreshness` helper (`rateCards`, `audience`, `reach`, `avgViews`, `topics`, `languages`, `formats`). `profile_data_point_keys[]` SHALL list the `ProfileDataPoint.field` roots that count as a satisfying observation for this target (e.g. `["rate"]` for `rate_card`); matching is exact-or-dotted-subkey (`rate` matches `rate.post`, `audience.geo` matches `audience.geo.ru`) through the shared `profileFieldMatchesTarget(...)` helper. Registry contents SHALL be validated via zod at module load.

#### Scenario: Registry exposes all four agency defaults

- **WHEN** the shared module loads
- **THEN** the registry contains entries for `rate_card`, `reach`, `audience_demographics`, `geo`, each with a non-empty `label`, `description_for_operator`, `description_for_agent`, `question_template`, a valid `freshness_section`, and a non-empty `profile_data_point_keys[]`

#### Scenario: Loading a malformed registry entry fails fast

- **WHEN** an engineer accidentally ships an entry whose `freshness_section` is not a known section
- **THEN** the module load throws a validation error in CI so the build fails before deploy

### Requirement: Registry is the single source of truth for planner + HUD + gate metadata

The `DataCollectionPlanner`, the data-collection HUD endpoint, and any future gate prompt SHALL resolve target labels, operator descriptions, agent descriptions, deterministic question phrasing, freshness-section mapping, and the `ProfileDataPoint.field` match list from this registry. There SHALL be no hardcoded duplicates of `QUESTION_TEMPLATES`, `TARGET_FIELD_KEYWORDS`, or `AGENCY_DEFAULT_TARGETS` in agent / worker / API code after this change — those constants SHALL be derived from the registry and its helpers.

#### Scenario: Editing a label updates the operator UI and the planner question in one place

- **WHEN** an engineer changes the `label` and `question_template` of `rate_card` in the registry
- **THEN** the HUD renders the new label, the planner emits the new question, and no other module needs editing

#### Scenario: Unknown campaign target is dropped at read time

- **WHEN** a campaign's `goal.target_data_points` contains a key absent from the registry
- **THEN** the planner and the HUD silently drop the unknown key and log a warning with the campaign id, the unknown key, and the conversation id when applicable

### Requirement: Per-campaign target lists derive from goal + registry

The effective HUD target list for a conversation SHALL be the intersection of `campaign.goal.target_data_points` (when set) with the registry, falling back to the agency default set (`rate_card`, `reach`, `audience_demographics`, `geo`) when `goal.target_data_points` is absent or empty. The effective planner target list SHALL be the HUD target list with `manual_only` entries removed.

#### Scenario: Campaign overrides default targets

- **WHEN** a campaign sets `goal.target_data_points = ["rate_card", "reach"]`
- **THEN** only those two targets are surfaced to the planner and the HUD

#### Scenario: Campaign without explicit targets uses the default set

- **WHEN** a campaign has no `goal.target_data_points`
- **THEN** the effective target list equals the agency default set

### Requirement: manual_only targets are surfaced but never auto-captured

A registry entry with `manual_only = true` SHALL be surfaced in the HUD when explicitly included in a campaign's `target_data_points` (so the operator sees the gap) but SHALL be excluded from the planner target list and from automated `goal_satisfied` checks. It SHALL NOT be considered "answered" or "stale" from extractor-written `ProfileDataPoint` rows. In Phase 1 there is no operator-action write path for manual-only fields, so such targets remain operator-facing gaps until a later phase adds an explicit action.

#### Scenario: deals_contact is surfaced as manual-only

- **WHEN** the registry declares `deals_contact { manual_only: true }` and the campaign's effective target list includes it
- **THEN** the HUD shows `deals_contact` with a "manual" badge, the planner does not auto-ask it, it does not block `goal_satisfied`, and no `ProfileDataPoint` write for an arbitrary `contact.*` field is treated as satisfying it
