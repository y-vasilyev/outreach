import { z } from 'zod';
import {
  PlacementAttributeZ,
  PlacementOfferZ,
  type PlacementAttribute,
  type PlacementOffer,
} from './schemas/placement-offer.js';
import { getOfferAttribute, offerIdentityKey } from './placement-offers.js';
import { CONFIDENCE_BAND, PLACEMENT_OFFER_CONFIDENCE_FLOOR } from './profile-rollup.js';

/**
 * Placement offer ROWS (placement-offer-table): pure mapping + write-decision
 * logic between the stored `PlacementOffer` JSON shape and the first-class
 * `placement_offer` table. IO-free — the Prisma write helper in `@nosquare/db`
 * and the backfill script call these, so identity/lifecycle semantics live in
 * exactly one place and are unit-testable without a database.
 */

export const PLACEMENT_OFFER_ROW_STATUSES = ['active', 'superseded', 'low_confidence'] as const;
export type PlacementOfferRowStatus = (typeof PLACEMENT_OFFER_ROW_STATUSES)[number];

/** Typed-column fields derived from an offer for one `placement_offer` row. */
export interface OfferRowFields {
  platform: string | null;
  kind: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  duration: string | null;
  tariffName: string | null;
  slot: string | null;
  identityKey: string;
  confidence: number;
  attributes: PlacementAttribute[];
  rawPrice: string;
  rawSnippet: string;
  sourceMessageId: string | null;
  extractedBy: string;
  capturedAt: Date;
}

/** Minimal row shape the pure helpers need (a subset of PlacementOfferRow). */
export interface PlacementOfferRowLike {
  id: string;
  platform: string | null;
  kind: string;
  priceMin: unknown; // Prisma Decimal | number | string | null
  priceMax: unknown;
  currency: string;
  identityKey: string;
  status: string;
  confidence: unknown; // Prisma Decimal | number
  attributes: unknown; // Json — PlacementAttribute[]
  rawPrice: string;
  rawSnippet: string;
  sourceMessageId: string | null;
  extractedBy: string;
  capturedAt: Date | string;
  createdAt: Date | string;
}

/** Coerce a Prisma Decimal / string / number to a finite number or null. */
export function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && 'toNumber' in (v as object)) {
    const n = (v as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function attrString(offer: PlacementOffer, key: string): string | null {
  const v = getOfferAttribute(offer, key);
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Derive the typed row columns from a stored offer. The verbatim `attributes`
 * list is carried whole (identity attrs are DUPLICATED into columns for SQL,
 * never moved out), so `rowToOffer` can reconstruct the exact offer shape.
 * Single-price offers store priceMin = priceMax (price-normalization-v2 will
 * introduce genuine ranges); term-only offers store both null.
 */
export function offerToRowFields(offer: PlacementOffer): OfferRowFields {
  const price = typeof offer.price === 'number' && Number.isFinite(offer.price) ? offer.price : null;
  return {
    platform: offer.platform ?? null,
    kind: offer.kind,
    priceMin: price,
    priceMax: price,
    currency: offer.currency?.trim() || 'RUB',
    duration: attrString(offer, 'duration'),
    tariffName: attrString(offer, 'tariff_name'),
    slot: attrString(offer, 'slot'),
    identityKey: offerIdentityKey(offer),
    confidence: offer.confidence,
    attributes: offer.attributes,
    rawPrice: offer.rawPrice ?? '',
    rawSnippet: offer.rawSnippet,
    sourceMessageId: offer.sourceMessageId,
    extractedBy: offer.extractedBy,
    capturedAt: offer.capturedAt ? new Date(offer.capturedAt) : new Date(),
  };
}

/**
 * Reconstruct the `PlacementOffer` JSON shape from a row. Returns null when the
 * stored attributes are unreadable (logged by the caller — the row itself stays
 * untouched; never throws on a single bad row, mirroring the tolerant
 * per-element parse from harden-reply-extraction).
 */
export function rowToOffer(row: PlacementOfferRowLike): PlacementOffer | null {
  const attrs = z.array(PlacementAttributeZ).safeParse(row.attributes ?? []);
  if (!attrs.success) return null;
  const capturedAt =
    row.capturedAt instanceof Date ? row.capturedAt.toISOString() : String(row.capturedAt);
  const candidate = {
    kind: row.kind,
    platform: row.platform,
    price: decimalToNumber(row.priceMin),
    currency: row.currency,
    attributes: attrs.data,
    confidence: decimalToNumber(row.confidence) ?? 0,
    rawSnippet: row.rawSnippet,
    rawPrice: row.rawPrice,
    sourceMessageId: row.sourceMessageId,
    extractedBy: row.extractedBy,
    capturedAt,
  };
  const parsed = PlacementOfferZ.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Compose the rolled-up `placementOffers` view from offer ROWS: `active` rows
 * only (low_confidence/superseded never roll up), ordered by creation so the
 * output ordering matches the legacy compose-from-data-points path (first
 * appearance order). Unreadable rows are skipped and reported via `onSkip`.
 */
export function composeOffersFromRows(
  rows: PlacementOfferRowLike[],
  onSkip?: (rowId: string) => void,
): PlacementOffer[] {
  const toMs = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
  const out: PlacementOffer[] = [];
  const active = rows
    .filter((r) => r.status === 'active')
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  for (const row of active) {
    const conf = decimalToNumber(row.confidence) ?? 0;
    if (conf < PLACEMENT_OFFER_CONFIDENCE_FLOOR) continue;
    const offer = rowToOffer(row);
    if (!offer) {
      onSkip?.(row.id);
      continue;
    }
    out.push(offer);
  }
  return out;
}

/** One serialized offer row in the profile read API (Decimals → numbers). */
export interface OfferHistoryRow {
  id: string;
  status: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  confidence: number;
  rawPrice: string;
  rawSnippet: string;
  sourceMessageId: string | null;
  supersededById: string | null;
  capturedAt: string;
}

/** Per-identity offer history: the active row + its superseded generations. */
export interface OfferHistoryEntry {
  identityKey: string;
  platform: string | null;
  kind: string;
  duration: string | null;
  tariffName: string | null;
  slot: string | null;
  active: OfferHistoryRow | null;
  /** Non-active rows, newest first — prior prices and low-confidence captures. */
  history: OfferHistoryRow[];
}

type HistorySourceRow = PlacementOfferRowLike & {
  duration?: string | null;
  tariffName?: string | null;
  slot?: string | null;
  supersededById?: string | null;
};

function toHistoryRow(row: HistorySourceRow): OfferHistoryRow {
  return {
    id: row.id,
    status: row.status,
    priceMin: decimalToNumber(row.priceMin),
    priceMax: decimalToNumber(row.priceMax),
    currency: row.currency,
    confidence: decimalToNumber(row.confidence) ?? 0,
    rawPrice: row.rawPrice,
    rawSnippet: row.rawSnippet,
    sourceMessageId: row.sourceMessageId,
    supersededById: row.supersededById ?? null,
    capturedAt:
      row.capturedAt instanceof Date ? row.capturedAt.toISOString() : String(row.capturedAt),
  };
}

/**
 * Group offer rows into per-identity history entries for the profile read API
 * («как менялась цена этого продукта»): active row + prior generations newest
 * first. Entries are ordered by their newest row's capturedAt desc.
 */
export function buildOfferHistory(rows: HistorySourceRow[]): OfferHistoryEntry[] {
  const toMs = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
  const byIdentity = new Map<string, HistorySourceRow[]>();
  for (const row of rows) {
    const arr = byIdentity.get(row.identityKey) ?? [];
    arr.push(row);
    byIdentity.set(row.identityKey, arr);
  }
  const entries: Array<{ entry: OfferHistoryEntry; newestMs: number }> = [];
  for (const [identityKey, group] of byIdentity) {
    const sorted = [...group].sort((a, b) => toMs(b.capturedAt) - toMs(a.capturedAt));
    const newest = sorted[0]!;
    const activeRow = sorted.find((r) => r.status === 'active') ?? null;
    entries.push({
      newestMs: toMs(newest.capturedAt),
      entry: {
        identityKey,
        platform: newest.platform,
        kind: newest.kind,
        duration: newest.duration ?? null,
        tariffName: newest.tariffName ?? null,
        slot: newest.slot ?? null,
        active: activeRow ? toHistoryRow(activeRow) : null,
        history: sorted.filter((r) => r.status !== 'active').map(toHistoryRow),
      },
    });
  }
  return entries.sort((a, b) => b.newestMs - a.newestMs).map((e) => e.entry);
}

/** The write-time resolution for one incoming offer vs the current active row. */
export type OfferRowWriteDecision =
  | { insertStatus: 'low_confidence'; supersedeExistingId: null; supersededById: null }
  | { insertStatus: 'active'; supersedeExistingId: string | null; supersededById: null }
  | { insertStatus: 'superseded'; supersedeExistingId: null; supersededById: string };

/**
 * Supersede-by-identity (design D4), as a pure decision so the worker, the
 * backfill, and the tests share one brain:
 *   - sub-floor confidence → insert `low_confidence`, never supersedes;
 *   - no active row with this identity → insert `active`;
 *   - same price/currency → the confidence-band freshness rule picks the
 *     surviving `active` row (|Δconfidence| ≤ band → fresher wins, else higher
 *     confidence); the loser is/becomes `superseded`;
 *   - different price, incoming at least as recent → the incoming row becomes
 *     `active`, the prior is superseded — that chain IS the price history;
 *   - different price, incoming OLDER (delayed retry / out-of-order job /
 *     re-run of an old message; `capturedAt` = source-message time) → the
 *     incoming row lands directly as `superseded` so an outdated quote can
 *     never dethrone the current price.
 */
export function decideOfferRowWrite(
  incoming: { priceMin: number | null; currency: string; confidence: number; capturedAt: Date },
  existingActive: {
    id: string;
    priceMin: unknown;
    currency: string;
    confidence: unknown;
    capturedAt: Date | string;
  } | null,
): OfferRowWriteDecision {
  if (incoming.confidence < PLACEMENT_OFFER_CONFIDENCE_FLOOR) {
    return { insertStatus: 'low_confidence', supersedeExistingId: null, supersededById: null };
  }
  if (!existingActive) {
    return { insertStatus: 'active', supersedeExistingId: null, supersededById: null };
  }
  const existingPrice = decimalToNumber(existingActive.priceMin);
  const existingMs =
    existingActive.capturedAt instanceof Date
      ? existingActive.capturedAt.getTime()
      : Date.parse(String(existingActive.capturedAt));
  const samePrice =
    existingPrice === incoming.priceMin &&
    existingActive.currency.toLowerCase() === incoming.currency.toLowerCase();
  if (!samePrice) {
    if (incoming.capturedAt.getTime() >= existingMs) {
      return { insertStatus: 'active', supersedeExistingId: existingActive.id, supersededById: null };
    }
    return { insertStatus: 'superseded', supersedeExistingId: null, supersededById: existingActive.id };
  }
  const existingConf = decimalToNumber(existingActive.confidence) ?? 0;
  const sameBand = Math.abs(existingConf - incoming.confidence) <= CONFIDENCE_BAND;
  const incomingWins = sameBand
    ? incoming.capturedAt.getTime() >= existingMs
    : incoming.confidence > existingConf;
  if (incomingWins) {
    return { insertStatus: 'active', supersedeExistingId: existingActive.id, supersededById: null };
  }
  return { insertStatus: 'superseded', supersedeExistingId: null, supersededById: existingActive.id };
}
