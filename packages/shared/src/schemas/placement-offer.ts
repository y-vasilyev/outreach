import { z } from 'zod';
import { normalizePriceToken } from '../price.js';

/**
 * Coerce a price input to a finite non-negative number or null. Accepts numbers
 * and the free-form price strings bloggers write ("от 118000", "118 000",
 * "1.2млн", "50к"). A non-coercible value yields null (term-only offer) rather
 * than rejecting the whole offer — harden-reply-extraction D2.
 */
const PriceCoerceZ = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string') return normalizePriceToken(v);
  return null;
}, z.number().nonnegative().nullable());

/**
 * Structured commercial placement offers (entity-style-rate-cards change).
 *
 * Real blogger quotes describe placements as commercial objects, not flat
 * formats: "пост на сутки", "пост на месяц", "выездной обзор без удаления",
 * "+ налог 6%". Encoding those into synthetic `rate.<format>` strings loses the
 * terms. A `PlacementOffer` keeps each placement as a typed object with stable
 * `kind`, promoted hot fields (`platform`, `price`, `currency`), an open list
 * of typed `attributes`, confidence, and full source provenance.
 *
 * The active set of attribute keys is governed by the
 * `PlacementAttributeRegistry` (see `placement-offers.ts`). Extraction can
 * propose new attributes (`PlacementAttributeProposal`); proposals stay
 * inactive until an operator/config rule approves them — arbitrary LLM output
 * never mutates the active registry.
 *
 * Storage (design D1): offers are persisted as typed JSON — granular
 * `ProfileDataPoint` rows with `field = "placement.offer"` and a validated
 * `PlacementOffer` value — and rolled up onto `BloggerProfile.placementOffers`.
 * Legacy `rateCards`/`formats` are derived from offers for compatibility.
 */

/** Value types an attribute can carry. `enum` is a string constrained to a set. */
export const PlacementAttributeTypeZ = z.enum([
  'string',
  'number',
  'boolean',
  'enum',
  'string_list',
]);
export type PlacementAttributeType = z.infer<typeof PlacementAttributeTypeZ>;

/** A single attribute value (the union of all supported attribute types). */
export const PlacementAttributeValueZ = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type PlacementAttributeValue = z.infer<typeof PlacementAttributeValueZ>;

/**
 * One typed, keyed attribute on an offer, with its own provenance. `key` is a
 * registry attribute key (e.g. `duration`, `delete_policy`, `includes`, `tax`,
 * `notes`). Whether the key is *active* is decided against the registry at
 * validation time, not here.
 */
export const PlacementAttributeZ = z.object({
  key: z.string().min(1),
  value: PlacementAttributeValueZ,
  confidence: z.number().min(0).max(1).default(1),
  rawSnippet: z.string().default(''),
});
export type PlacementAttribute = z.infer<typeof PlacementAttributeZ>;

/**
 * Known placement kinds. Kept as a documented constant but offers accept any
 * non-empty string so a novel kind is preserved for review rather than dropped.
 * `package` is the escape hatch for an ambiguous bundle whose composition the
 * extractor could not split (design: keep low-confidence offers reviewable).
 */
export const KNOWN_PLACEMENT_KINDS = [
  'post',
  'story',
  'reels',
  'shorts',
  'video',
  'integration',
  'offsite_review',
  'package',
  'other',
] as const;
export type KnownPlacementKind = (typeof KNOWN_PLACEMENT_KINDS)[number];

/**
 * Stash the literal price text into `rawPrice` BEFORE `PriceCoerceZ` collapses
 * it to a number (placement-offer-table: lossy coercion must stay reversible —
 * «от 118 000» → priceMin 118000, but the row keeps the verbatim token).
 * Only fires when the input price is a string and no rawPrice was provided.
 */
function stashRawPrice(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o['price'] === 'string' && !o['rawPrice']) {
      return { ...o, rawPrice: o['price'] };
    }
  }
  return v;
}

/**
 * Structured placement offer as emitted by extraction (a "draft" — provenance
 * fields `sourceMessageId`/`extractedBy`/`capturedAt` are stamped on persist by
 * the worker). `price` is nullable so an ambiguous package whose price is known
 * but whose unit is not, or a term-only offer, is still preserved.
 */
const PlacementOfferDraftShapeZ = z.object({
  kind: z.string().min(1),
  /** Platform (telegram/youtube/instagram/vk/tiktok) — promoted hot field. */
  platform: z.string().nullish().transform((v) => v ?? null),
  price: PriceCoerceZ,
  currency: z.string().default('RUB'),
  attributes: z.array(PlacementAttributeZ).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  rawSnippet: z.string().default(''),
  /** Literal price text as written, when the source had one («от 118 000»). */
  rawPrice: z.string().default(''),
});
export const PlacementOfferDraftZ = z.preprocess(stashRawPrice, PlacementOfferDraftShapeZ);
export type PlacementOfferDraft = z.infer<typeof PlacementOfferDraftZ>;

/**
 * Persisted/rolled-up placement offer: a draft plus source provenance. This is
 * the shape stored in the `placement.offer` data-point value and surfaced on
 * `BloggerProfile.placementOffers` and in the profile read API.
 */
export const PlacementOfferZ = z.preprocess(
  stashRawPrice,
  PlacementOfferDraftShapeZ.extend({
    sourceMessageId: z.string().nullable().default(null),
    extractedBy: z.string().default('llm'),
    capturedAt: z.string().nullable().default(null),
  }),
);
export type PlacementOffer = z.infer<typeof PlacementOfferZ>;

/**
 * One entry in the active placement attribute registry: defines an attribute's
 * key, value type, description, which placement kinds it applies to, allowed
 * enum values (for `enum`), and which kinds require it.
 *
 * `applicableKinds` empty = applies to all kinds. `requiredForKinds` lists the
 * kinds where the planner should chase the attribute when it is missing.
 */
export const PlacementAttributeRegistryEntryZ = z.object({
  key: z.string().min(1),
  valueType: PlacementAttributeTypeZ,
  description: z.string().min(1),
  applicableKinds: z.array(z.string()).default([]),
  enumValues: z.array(z.string()).optional(),
  requiredForKinds: z.array(z.string()).default([]),
  active: z.boolean().default(true),
});
export type PlacementAttributeRegistryEntry = z.infer<typeof PlacementAttributeRegistryEntryZ>;

/**
 * An inactive proposal for a new attribute, emitted by extraction when source
 * text contains a commercially relevant term the active registry does not
 * cover. Stays inactive (review metadata) until approved. Mirrors a registry
 * entry plus evidence/rationale/confidence and a review status.
 */
export const PlacementAttributeProposalDraftZ = z.object({
  suggestedKey: z.string().min(1),
  suggestedType: PlacementAttributeTypeZ,
  applicableKinds: z.array(z.string()).default([]),
  enumValues: z.array(z.string()).optional(),
  /** Verbatim source snippets that motivated the proposal. */
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  rationale: z.string().default(''),
});
export type PlacementAttributeProposalDraft = z.infer<typeof PlacementAttributeProposalDraftZ>;

export const PlacementProposalStatusZ = z.enum(['proposed', 'approved', 'rejected']);
export type PlacementProposalStatus = z.infer<typeof PlacementProposalStatusZ>;

/** Persisted attribute proposal (draft + review status + provenance). */
export const PlacementAttributeProposalZ = PlacementAttributeProposalDraftZ.extend({
  id: z.string(),
  status: PlacementProposalStatusZ.default('proposed'),
  sourceMessageId: z.string().nullable().default(null),
  proposedByRunId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlacementAttributeProposal = z.infer<typeof PlacementAttributeProposalZ>;
