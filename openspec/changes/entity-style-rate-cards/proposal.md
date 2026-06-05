## Why

Real blogger quotes describe placements as commercial objects, not flat formats: "post for 24h", "post for a month", "offsite review with permanent post", tax rules, bundled deliverables, and deletion policy all change the commercial meaning of the price. Encoding those details into synthetic strings like `rate.telegram_post_month` prevents immediate data loss, but it does not scale to new placement attributes or campaign-specific requirements.

## What Changes

- Introduce structured placement-offer records extracted from blogger replies and media kits: each offer has a stable `kind` plus typed attributes such as `platform`, `duration`, `delete_policy`, `includes`, `tax`, `currency`, `price`, confidence, and provenance.
- Add a placement attribute registry with required/optional attributes per placement kind and campaign target. Missing but relevant attributes can be proposed by LLM extraction as registry drafts, then reviewed before becoming active extraction fields.
- Extend `RateCardExtractor` from "emit `rate.<format>` price points" to "emit placement offers plus attribute-level evidence"; keep legacy `rateCards` populated as a compatibility roll-up.
- Update blogger profile reads to surface both the legacy `rateCards` array and structured `placementOffers`, so operators and future matching can inspect terms without parsing synthetic format strings.
- Update the data-collection planner so it asks for missing attributes on already-known placements instead of re-asking for the whole rate card.
- Keep operator control: automatic attribute creation is not a direct schema mutation. The system may create a proposed attribute with evidence and suggested type, but activation requires explicit approval or a preconfigured auto-approval rule.

## Capabilities

### New Capabilities

- `placement-offer-entities`: Structured commercial placement offers with typed attributes, provenance, compatibility roll-up to legacy rate cards, and controlled attribute discovery.

### Modified Capabilities

- `blogger-commercial-profile`: Add structured `placementOffers` alongside legacy `rateCards`, and require profile roll-up/read APIs to preserve offer attributes rather than collapsing them into one price per string format.
- `agency-sourcing-pipeline`: Extract placement offers and required attributes during inbound processing, and plan follow-up questions for missing attributes on known offers.
- `blogger-matching`: Allow matching logic to use structured placement attributes, such as platform, duration, deletion policy, included deliverables, tax, and price, while preserving current rate-card fallback behavior.

## Impact

- **Shared**: new zod schemas/types for `PlacementOffer`, `PlacementAttribute`, registry entries, extraction output, and legacy roll-up helpers.
- **Agents**: `RateCardExtractor` prompt/output schema changes to structured offers; deterministic parsers become offer builders; LLM output can include `attribute_proposals`.
- **Workers**: `profile-extract` persists offer-level and attribute-level data with source message provenance; planner consumes known offers and missing attributes.
- **API**: blogger profile detail/list responses include `placementOffers`; matching endpoints can accept structured placement constraints.
- **Web**: blogger catalog/card render placements as rows with attributes instead of opaque format strings; operator review UI shows proposed unknown attributes before activation.
- **Compatibility**: existing `rateCards` and `formats` remain populated from placement offers for current catalog/matching paths during migration.
