import type { RateCard } from './schemas/blogger-profile.js';
import type {
  PlacementAttribute,
  PlacementAttributeRegistryEntry,
  PlacementAttributeValue,
  PlacementOffer,
  PlacementOfferDraft,
} from './schemas/placement-offer.js';

/**
 * Placement attribute registry + offer helpers (entity-style-rate-cards).
 *
 * Pure, IO-free logic shared by extraction, persistence, roll-up, planning, and
 * matching:
 *   - the active v1 registry (`PLACEMENT_ATTRIBUTE_REGISTRY_V1`),
 *   - validation of an offer's attributes against a registry,
 *   - deterministic derivation of a legacy `rate.<format>` key from an offer,
 *   - conversion of structured offers to legacy `RateCard[]`.
 *
 * The registry constant is the seed source + fallback. At runtime the active
 * registry is the v1 constant merged with operator-approved proposals loaded
 * from the DB (see `mergeRegistry`).
 */

/**
 * v1 active registry. Task 1.2: `platform`, `kind`, `duration`, `delete_policy`,
 * `includes`, `tax`, `price`, `currency`, `notes`. `kind`/`price`/`currency`/
 * `platform` are *promoted* to top-level offer fields but are still registry
 * members so the planner can treat them uniformly as required facts.
 *
 * Per the design's open question, VAT/tax is modelled as a single free-form
 * `tax` note initially (e.g. "налог 6%") rather than split into rate/regime.
 */
export const PLACEMENT_ATTRIBUTE_REGISTRY_V1: PlacementAttributeRegistryEntry[] = [
  {
    key: 'platform',
    valueType: 'enum',
    description: 'Площадка размещения',
    applicableKinds: [],
    enumValues: ['telegram', 'youtube', 'instagram', 'vk', 'tiktok'],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'kind',
    valueType: 'enum',
    description: 'Тип размещения (пост, сторис, интеграция, выездной обзор, пакет)',
    applicableKinds: [],
    enumValues: [
      'post',
      'story',
      'reels',
      'shorts',
      'video',
      'integration',
      'offsite_review',
      'package',
      'other',
    ],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'duration',
    valueType: 'enum',
    description: 'Срок жизни размещения в ленте (сутки, месяц, бессрочно)',
    applicableKinds: ['post', 'story'],
    enumValues: ['day', 'week', 'month', 'permanent'],
    requiredForKinds: ['post'],
    active: true,
  },
  {
    key: 'delete_policy',
    valueType: 'enum',
    description: 'Удаляется ли публикация по истечении срока или остаётся навсегда',
    applicableKinds: ['post', 'story', 'integration', 'offsite_review'],
    enumValues: ['deleted', 'permanent'],
    requiredForKinds: ['post'],
    active: true,
  },
  {
    key: 'includes',
    valueType: 'string_list',
    description: 'Что входит в размещение (доп. посты, анонсы, упоминания)',
    applicableKinds: [],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'tax',
    valueType: 'string',
    description: 'Налог/НДС поверх цены, как указано блогером (напр. «налог 6%»)',
    applicableKinds: [],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'price',
    valueType: 'number',
    description: 'Цена размещения (promoted: offer.price)',
    applicableKinds: [],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'currency',
    valueType: 'string',
    description: 'Валюта цены (promoted: offer.currency)',
    applicableKinds: [],
    requiredForKinds: [],
    active: true,
  },
  {
    key: 'notes',
    valueType: 'string',
    description: 'Прочие условия размещения свободным текстом',
    applicableKinds: [],
    requiredForKinds: [],
    active: true,
  },
];

/** Attribute keys promoted to top-level offer fields (not stored in `attributes[]`). */
export const PROMOTED_OFFER_ATTRIBUTE_KEYS = ['kind', 'platform', 'price', 'currency'] as const;

/** Index a registry by key for O(1) lookup (active entries win on key collision). */
export function indexRegistry(
  entries: PlacementAttributeRegistryEntry[],
): Map<string, PlacementAttributeRegistryEntry> {
  const byKey = new Map<string, PlacementAttributeRegistryEntry>();
  for (const e of entries) {
    const existing = byKey.get(e.key);
    // Prefer an active entry over an inactive one for the same key.
    if (!existing || (!existing.active && e.active)) byKey.set(e.key, e);
  }
  return byKey;
}

/**
 * Merge the v1 constant with operator-approved attribute entries (e.g. loaded
 * from DB). Later entries override earlier ones by key. The result is the
 * *active* registry used by extraction/planning.
 */
export function mergeRegistry(
  base: PlacementAttributeRegistryEntry[],
  overrides: PlacementAttributeRegistryEntry[],
): PlacementAttributeRegistryEntry[] {
  const byKey = new Map<string, PlacementAttributeRegistryEntry>();
  for (const e of [...base, ...overrides]) byKey.set(e.key, e);
  return [...byKey.values()];
}

function valueMatchesType(entry: PlacementAttributeRegistryEntry, value: unknown): boolean {
  switch (entry.valueType) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return (
        typeof value === 'string' &&
        (!entry.enumValues || entry.enumValues.length === 0 || entry.enumValues.includes(value))
      );
    case 'string_list':
      return Array.isArray(value) && value.every((x) => typeof x === 'string');
  }
}

function kindApplies(entry: PlacementAttributeRegistryEntry, kind: string): boolean {
  return entry.applicableKinds.length === 0 || entry.applicableKinds.includes(kind);
}

export interface OfferAttributeValidation {
  /** Attributes whose key is an active, applicable, well-typed registry entry. */
  valid: PlacementAttribute[];
  /** Attributes whose key is not in the active registry (candidates for proposals). */
  unknown: PlacementAttribute[];
  /** Attributes whose key is active but value type / applicability is invalid. */
  invalid: PlacementAttribute[];
}

/**
 * Split an offer's `attributes[]` against an active registry. Unknown keys are
 * NOT accepted as collected facts — they are surfaced for proposal/review
 * (spec: "Unknown active attribute is not silently accepted").
 */
export function validateOfferAttributes(
  offer: Pick<PlacementOfferDraft, 'kind' | 'attributes'>,
  registry: PlacementAttributeRegistryEntry[] = PLACEMENT_ATTRIBUTE_REGISTRY_V1,
): OfferAttributeValidation {
  const byKey = indexRegistry(registry);
  const out: OfferAttributeValidation = { valid: [], unknown: [], invalid: [] };
  for (const attr of offer.attributes) {
    const entry = byKey.get(attr.key);
    if (!entry || !entry.active) {
      out.unknown.push(attr);
      continue;
    }
    if (!kindApplies(entry, offer.kind) || !valueMatchesType(entry, attr.value)) {
      out.invalid.push(attr);
      continue;
    }
    out.valid.push(attr);
  }
  return out;
}

/**
 * Minimal offer view the attribute helpers read. Promoted fields are optional
 * so callers that only have `kind`/`platform`/`attributes` (e.g. format-key
 * derivation) can pass a narrower object.
 */
export type OfferAttributeView = {
  kind: string;
  platform?: string | null;
  price?: number | null;
  currency?: string;
  attributes: PlacementAttribute[];
};

/** Read an attribute value off an offer, honouring the promoted top-level fields. */
export function getOfferAttribute(
  offer: OfferAttributeView,
  key: string,
): PlacementAttributeValue | null {
  if (key === 'kind') return offer.kind;
  if (key === 'platform') return offer.platform ?? null;
  if (key === 'price') return offer.price ?? null;
  if (key === 'currency') return offer.currency ?? null;
  const found = offer.attributes.find((a) => a.key === key);
  return found ? found.value : null;
}

/** True when the offer carries a usable value for the attribute key. */
export function offerHasAttribute(
  offer: OfferAttributeView,
  key: string,
): boolean {
  const v = getOfferAttribute(offer, key);
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Required attribute keys missing from an offer, given an active registry.
 * Drives the planner's focused follow-ups. `extraRequiredKeys` lets a campaign
 * require attributes beyond the registry's `requiredForKinds` defaults.
 */
export function missingRequiredAttributes(
  offer: OfferAttributeView,
  registry: PlacementAttributeRegistryEntry[] = PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  extraRequiredKeys: string[] = [],
): string[] {
  const missing: string[] = [];
  const required = new Set<string>(extraRequiredKeys);
  for (const e of registry) {
    if (e.active && e.requiredForKinds.includes(offer.kind)) required.add(e.key);
  }
  for (const key of required) {
    if (!offerHasAttribute(offer, key)) missing.push(key);
  }
  return missing;
}

const DURATION_FORMAT_SUFFIX: Record<string, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * Deterministic legacy `rate.<format>` key (without the `rate.` prefix) from an
 * offer's stable attributes — platform, kind, duration. Built to match the keys
 * the legacy text extractor already produces (`telegram_post_month`,
 * `telegram_post_day`, `offsite_review`, `telegram_integration`, …) so derived
 * rate cards line up with existing consumers.
 */
export function derivePlacementFormatKey(
  offer: Pick<PlacementOfferDraft, 'kind' | 'platform' | 'attributes'>,
): string {
  const platform = (offer.platform ?? '').trim().toLowerCase();
  const kind = offer.kind.trim().toLowerCase();
  const duration = getOfferAttribute(offer, 'duration');
  const durationSuffix =
    typeof duration === 'string' ? DURATION_FORMAT_SUFFIX[duration.toLowerCase()] : undefined;

  // offsite_review historically carries no platform prefix.
  if (kind === 'offsite_review') return 'offsite_review';

  const prefix = platform ? `${platform}_` : '';
  if (kind === 'post' && durationSuffix) return `${prefix}post_${durationSuffix}`;
  return `${prefix}${kind}`;
}

/**
 * Derive legacy `RateCard[]` from structured offers — one per offer with a
 * usable price. The structured offer remains the source of truth for terms; the
 * synthetic `format` key is compatibility-only. Two same-kind offers (e.g. day
 * vs month post) yield two distinct rate cards rather than collapsing to one
 * (spec: "Two same-kind offers remain distinct").
 */
export function placementOffersToRateCards(
  offers: ReadonlyArray<Pick<PlacementOfferDraft, 'kind' | 'platform' | 'price' | 'currency' | 'attributes'>>,
): RateCard[] {
  const cards: RateCard[] = [];
  const seen = new Set<string>();
  for (const offer of offers) {
    if (typeof offer.price !== 'number' || !Number.isFinite(offer.price)) continue;
    const format = derivePlacementFormatKey(offer);
    const currency = offer.currency?.trim() || 'RUB';
    const key = `${format}:${offer.price}:${currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ format, price: offer.price, currency });
  }
  return cards;
}

/** Distinct offered format strings derived from structured offers. */
export function placementOffersToFormats(
  offers: ReadonlyArray<Pick<PlacementOfferDraft, 'kind' | 'platform' | 'attributes'>>,
): string[] {
  const out: string[] = [];
  for (const offer of offers) {
    const f = derivePlacementFormatKey(offer);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** Stamp persistence provenance onto a draft offer, producing a stored offer. */
export function stampOfferProvenance(
  draft: PlacementOfferDraft,
  provenance: { sourceMessageId: string | null; extractedBy?: string; capturedAt: string },
): PlacementOffer {
  return {
    ...draft,
    sourceMessageId: provenance.sourceMessageId,
    extractedBy: provenance.extractedBy ?? 'llm',
    capturedAt: provenance.capturedAt,
  };
}
