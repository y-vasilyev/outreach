import { z } from 'zod';
import { normalizePriceToken, parsePriceRange } from '../price.js';

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
 * Object-level pre-pass before field coercion (placement-offer-table +
 * price-normalization-v2):
 *   1. stash the literal price text into `rawPrice` BEFORE `PriceCoerceZ`
 *      collapses it («от 118 000» → 118000, but the verbatim token survives);
 *   2. expand a RANGE price string into `price_min`/`price_max` («5-7к» →
 *      5000/7000; «от 118 000» → 118000/null; «до 30к» → null/30000) unless
 *      the emitter already set explicit bounds;
 *   3. keep the legacy `price` field = `price_min` so every existing consumer
 *      (dedupe keys, format derivation, matching) is unchanged.
 */
function stashRawPrice(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  const firstPriceString = [o['price'], o['price_min'], o['price_max']].find(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  if (firstPriceString && !o['rawPrice']) o['rawPrice'] = firstPriceString;
  // Range expansion from a string `price` — only when bounds weren't given.
  if (typeof o['price'] === 'string' && o['price_min'] === undefined && o['price_max'] === undefined) {
    const r = parsePriceRange(o['price']);
    if (r && !(r.min !== null && r.min === r.max)) {
      o['price_min'] = r.min;
      o['price_max'] = r.max;
    }
  }
  // Legacy compatibility: `price` mirrors `price_min`.
  if ((o['price'] === undefined || o['price'] === null || typeof o['price'] === 'string') && o['price_min'] != null) {
    o['price'] = o['price_min'];
  }
  return o;
}

/** Post-parse consistency: explicit `price` and `price_min` must agree. */
function refineOfferPrices(
  offer: { price: number | null; price_min?: number | null; price_max?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (
    offer.price !== null &&
    offer.price_min !== null &&
    offer.price_min !== undefined &&
    offer.price !== offer.price_min
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'price must equal price_min when both are present',
      path: ['price'],
    });
  }
  if (
    offer.price_min != null &&
    offer.price_max != null &&
    offer.price_min > offer.price_max
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'price_min must be <= price_max',
      path: ['price_min'],
    });
  }
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
  /**
   * Optional price RANGE bounds (price-normalization-v2): «5-7к» → 5000/7000;
   * «от X» → min=X, max=null (open-ended); «до X» → min=null, max=X. `price`
   * stays = `price_min` for legacy consumers; both absent = exact/term-only.
   */
  price_min: PriceCoerceZ.optional(),
  price_max: PriceCoerceZ.optional(),
  currency: z.string().default('RUB'),
  attributes: z.array(PlacementAttributeZ).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  rawSnippet: z.string().default(''),
  /** Literal price text as written, when the source had one («от 118 000»). */
  rawPrice: z.string().default(''),
});
export const PlacementOfferDraftZ = z
  .preprocess(stashRawPrice, PlacementOfferDraftShapeZ)
  .superRefine(refineOfferPrices);
export type PlacementOfferDraft = z.infer<typeof PlacementOfferDraftZ>;

/**
 * Persisted/rolled-up placement offer: a draft plus source provenance. This is
 * the shape stored in the `placement.offer` data-point value and surfaced on
 * `BloggerProfile.placementOffers` and in the profile read API.
 */
/**
 * Derived normalization view attached to a rolled-up offer when it adds
 * information (price-normalization-v2): a real fx conversion and/or a CPM.
 * Computed from the offer ROW's derived columns by `rowToOffer` — never
 * emitted by extraction, never stored in the data-point JSON.
 */
export const NormalizedOfferViewZ = z.object({
  priceRubMin: z.number().nullable().default(null),
  priceRubMax: z.number().nullable().default(null),
  cpmRub: z.number().nullable().default(null),
  fxRateUsed: z.number().nullable().default(null),
  fxAsOf: z.string().nullable().default(null),
  viewsBasis: z.number().nullable().default(null),
  viewsSource: z.string().nullable().default(null),
});
export type NormalizedOfferView = z.infer<typeof NormalizedOfferViewZ>;

export const PlacementOfferZ = z
  .preprocess(
    stashRawPrice,
    PlacementOfferDraftShapeZ.extend({
      sourceMessageId: z.string().nullable().default(null),
      extractedBy: z.string().default('llm'),
      capturedAt: z.string().nullable().default(null),
      normalized: NormalizedOfferViewZ.optional(),
    }),
  )
  .superRefine(refineOfferPrices);
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
