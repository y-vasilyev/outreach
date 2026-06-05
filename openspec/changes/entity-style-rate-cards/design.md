## Context

The current commercial profile stores prices as flat `rate.<format>` data points and rolls them up into `rateCards: [{ format, price, currency }]`. This works for simple "post 15000" replies, but real quotes encode terms as attributes: platform, placement kind, duration, deletion policy, included deliverables, tax, package composition, and source evidence. The tactical regression fix can encode some terms into names such as `telegram_post_month`, but that shifts semantics into strings and makes the next unseen attribute another parser patch.

This change introduces structured placement offers as a compatibility layer before the larger EAV-authoritative roadmap. Offers are extracted and persisted with provenance, then rolled up to the existing `rateCards` shape so the catalog and matching continue to work during migration.

## Goals / Non-Goals

**Goals:**
- Represent each commercial placement as an entity-like offer with typed attributes.
- Preserve all source evidence and confidence at the offer and attribute level.
- Let LLM extraction propose new attributes when real quotes mention terms not in the active registry.
- Keep attribute activation controlled by operator/config review, with optional explicit auto-approval rules.
- Keep legacy `rateCards` and `formats` populated from structured offers until downstream code fully migrates.
- Let the data-collection planner ask for missing attributes on known offers.

**Non-Goals:**
- Do not make the full EAV store authoritative in this change.
- Do not remove `ProfileDataPoint`, `rateCards`, or current catalog/matching fallbacks.
- Do not let arbitrary LLM output mutate production schema or registry definitions without a gate.
- Do not solve offer deduplication across different channels owned by the same blogger; that belongs to the Blogger aggregate roadmap.

## Decisions

### Store placement offers as typed JSON first, not new relational tables

Add a `placementOffers` profile field and granular data points whose values are validated JSON objects. This avoids a schema-heavy migration while the offer shape stabilizes. The value still has a strict shared zod schema, and each attribute carries provenance.

Alternative considered: introduce normalized `placement_offer` and `placement_offer_attribute` tables immediately. That gives stronger queryability, but it couples a still-evolving taxonomy to a database migration and overlaps with the pending EAV roadmap.

### Attribute registry is controlled, with LLM proposals as drafts

The active registry defines known attributes by key, type, description, applicability, and requiredness. Extractors can emit `attribute_proposals[]` for terms such as a novel deletion policy or bundle attribute. The proposal includes suggested key/type, evidence snippets, affected placement kind, and confidence. It is stored as review metadata and is inactive until approved or matched by an explicit auto-approval rule.

Alternative considered: auto-create every missing attribute directly. That would preserve more text quickly, but it risks registry pollution from one-off phrasing, hallucinated attributes, and synonyms that should merge into existing keys.

### Legacy rate cards are derived from structured offers

For compatibility, each offer with a usable price produces one legacy `RateCard` entry. The derived `format` is a deterministic key built from stable attributes such as platform, kind, and duration. The source of truth for terms is the offer, not the synthetic format string.

Alternative considered: stop generating legacy rate cards after adding offers. That would break catalog, matching, freshness, and existing tests before the UI and matcher are migrated.

### Offer identity is local and evidence-based

Within one source message, offers are deduped by `(platform, kind, duration/delete policy, price, currency, rawSnippet)`. Across messages, roll-up chooses the best current version by confidence and recency, while preserving older offers as evidence. There is no cross-channel blogger-level dedupe yet.

Alternative considered: assign durable semantic offer IDs across messages immediately. That requires merge/split UI and is better handled after operators can inspect structured offers.

### Planner asks for missing attributes, not only missing targets

The data-collection planner receives known offers and required attributes for the campaign. If an offer has price but no duration/delete policy/tax where required, the planner asks a focused follow-up instead of re-asking for "rate card".

Alternative considered: keep planner target-level only. That would keep implementation small, but it repeats the current failure mode where collected price is treated as complete even when commercial terms are missing.

## Risks / Trade-offs

- Attribute registry grows noisy -> Mitigation: inactive proposals by default, synonym matching, and review UI before activation.
- JSON storage limits ad-hoc SQL filtering -> Mitigation: maintain legacy roll-up fields now; defer indexed relational/EAV projection until the taxonomy stabilizes.
- LLM may split one package into too many offers -> Mitigation: allow `kind=package` and `includes[]`; keep low-confidence offers reviewable, not silently dropped.
- Derived legacy format keys can still be imperfect -> Mitigation: keep them compatibility-only and render structured attributes in the UI.
- Planner may ask overly specific follow-ups -> Mitigation: required attributes are campaign/placement-kind scoped and can be tuned in the registry.

## Migration Plan

1. Add shared schemas and registry defaults behind a feature flag `structured_placement_offers`.
2. Dual-write structured placement offers from `RateCardExtractor` while continuing to write legacy `rate.*` data points.
3. Add read API fields and UI rendering while preserving existing `rateCards` output.
4. Teach planner to consume structured offers when the flag is enabled; otherwise keep current target behavior.
5. Teach matcher to prefer structured attributes when present and fall back to legacy `rateCards`.
6. After operational validation, make structured offers the preferred source for rate card rendering and keep legacy fields as derived cache.

Rollback: disable `structured_placement_offers`; extraction and reads continue through legacy `rateCards`. Structured offer data remains stored but ignored.

## Open Questions

- Which attributes are globally required for `agency_sourcing` v1: `duration`, `delete_policy`, `includes`, and `tax`, or only a campaign-selected subset?
- Should VAT/tax be modeled as `tax_included`, `tax_rate`, and `tax_regime`, or a single free-form `tax_note` initially?
- What approval path should activate proposed attributes: admin page, config PR, or operator action inside the inbox?
