## ADDED Requirements

### Requirement: Agency inbound extraction creates placement offers
For `agency_sourcing` conversations, the inbound profile extraction path SHALL create structured placement offers from blogger replies and media-kit text when prices or commercial placement terms are present. The pipeline SHALL preserve low-confidence offers for operator review rather than silently dropping commercially relevant facts.

#### Scenario: Inline terms are extracted during inbound processing
- **WHEN** the latest inbound contains inline pricing such as "пост на сутки 13000, пост на месяц 21000"
- **THEN** the profile extraction pipeline creates separate structured placement offers and persists provenance to the source message

#### Scenario: Ambiguous package is kept for review
- **WHEN** the extractor cannot determine whether a price is for one format or a package
- **THEN** it emits a low-confidence package or unknown-kind offer with raw evidence instead of discarding the price

### Requirement: Planner asks for missing placement attributes
The `DataCollectionPlanner` SHALL receive known placement offers and active required attributes for the campaign. If an offer is missing a required attribute, the planner SHALL ask a focused follow-up about that attribute rather than re-asking for the whole rate card.

#### Scenario: Planner asks for deletion policy
- **WHEN** the blogger shared a post price but the active campaign target requires deletion policy and no `delete_policy` attribute is known
- **THEN** the planner asks whether the post is deleted after a fixed period or remains permanently

#### Scenario: Planner does not re-ask collected price
- **WHEN** an offer already has a usable price and currency
- **THEN** the planner SHALL NOT ask for price again unless the price is stale, low-confidence, or contradicted by newer evidence

### Requirement: Attribute proposals are routed to operator review
When extraction produces inactive attribute proposals, the agency pipeline SHALL surface them to the operator/admin review path without sending them to the contact and without treating them as completed data-collection targets.

#### Scenario: Proposed attribute is operator-only
- **WHEN** the extractor proposes a new attribute from a blogger reply
- **THEN** the proposal is visible to operators/admins for review and no outbound message mentions internal schema or attribute creation
