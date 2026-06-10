import type { Prisma } from '@prisma/client';
import {
  composeOffersFromRows,
  decideOfferRowWrite,
  offerToRowFields,
  rollUpProfileFields,
  type NormalizedOfferFields,
  type PlacementOffer,
  type RollupDataPoint,
} from '@nosquare/shared';

/**
 * Transactional write path for `placement_offer` rows (placement-offer-table).
 * Thin Prisma plumbing around the PURE decision logic in
 * `@nosquare/shared/placement-offer-rows` — the worker dual-write and the
 * backfill script both call this, so lifecycle semantics live in one place.
 *
 * Rows are NEVER deleted here (or anywhere): replacement marks the prior row
 * `superseded` with a `supersededById` chain. The partial unique index
 * `(profile_id, identity_key) WHERE status='active'` (migration 9f) backstops
 * concurrent same-identity writers: the losing transaction fails on the index
 * and the BullMQ retry then observes the winner and supersedes normally.
 */

type Tx = Prisma.TransactionClient;

export interface PersistOfferRowInput {
  profileId: string;
  offer: PlacementOffer;
  /** Plain ref to the originating `placement.offer` ProfileDataPoint row. */
  sourceDataPointId: string;
  /**
   * Write-time normalization (price-normalization-v2): RUB-derived columns +
   * CPM from `normalizeOffer()`. Omitted = all-null (unnormalized — visible,
   * excluded from RUB comparisons until renormalize runs).
   */
  normalized?: NormalizedOfferFields;
}

/**
 * Idempotently persist one offer row, resolving supersede-by-identity.
 * Idempotency key: `(profileId, sourceDataPointId)` — one row per originating
 * data point, so re-delivered jobs and a concurrently running backfill are
 * no-ops (`skipped`).
 */
export async function persistPlacementOfferRow(
  tx: Tx,
  input: PersistOfferRowInput,
): Promise<'created' | 'skipped'> {
  const existing = await tx.placementOfferRow.findFirst({
    where: { profileId: input.profileId, sourceDataPointId: input.sourceDataPointId },
    select: { id: true },
  });
  if (existing) return 'skipped';

  const fields = offerToRowFields(input.offer);
  const activeRow = await tx.placementOfferRow.findFirst({
    where: { profileId: input.profileId, identityKey: fields.identityKey, status: 'active' },
    select: {
      id: true,
      priceMin: true,
      priceMax: true,
      currency: true,
      confidence: true,
      capturedAt: true,
    },
  });

  const decision = decideOfferRowWrite(
    {
      priceMin: fields.priceMin,
      priceMax: fields.priceMax,
      currency: fields.currency,
      confidence: fields.confidence,
      capturedAt: fields.capturedAt,
    },
    activeRow,
  );

  // Flip the loser BEFORE inserting a new `active` row — the partial unique
  // index forbids two active rows per identity even transiently.
  if (decision.supersedeExistingId) {
    await tx.placementOfferRow.update({
      where: { id: decision.supersedeExistingId },
      data: { status: 'superseded' },
    });
  }

  const created = await tx.placementOfferRow.create({
    data: {
      profileId: input.profileId,
      platform: fields.platform,
      kind: fields.kind,
      priceMin: fields.priceMin,
      priceMax: fields.priceMax,
      currency: fields.currency,
      duration: fields.duration,
      tariffName: fields.tariffName,
      slot: fields.slot,
      identityKey: fields.identityKey,
      status: decision.insertStatus,
      supersededById: decision.supersededById,
      confidence: fields.confidence,
      attributes: fields.attributes as never,
      rawPrice: fields.rawPrice,
      rawSnippet: fields.rawSnippet,
      sourceDataPointId: input.sourceDataPointId,
      sourceMessageId: fields.sourceMessageId,
      extractedBy: fields.extractedBy,
      capturedAt: fields.capturedAt,
      ...(input.normalized
        ? {
            priceRubMin: input.normalized.priceRubMin,
            priceRubMax: input.normalized.priceRubMax,
            fxRateUsed: input.normalized.fxRateUsed,
            fxAsOf: input.normalized.fxAsOf,
            cpmRub: input.normalized.cpmRub,
            viewsBasis: input.normalized.viewsBasis,
            viewsSource: input.normalized.viewsSource,
          }
        : {}),
    },
    select: { id: true },
  });

  // Close the chain: the superseded row points at the row that replaced it.
  if (decision.supersedeExistingId) {
    await tx.placementOfferRow.update({
      where: { id: decision.supersedeExistingId },
      data: { supersededById: created.id },
    });
  }
  return 'created';
}

/** How the rolled-up `placementOffers` view was sourced (ops visibility). */
export type OfferRollupSource = 'offer_rows' | 'legacy_fallback' | 'legacy_partial';

/**
 * Rows-aware placement-offer composition for EVERY profile re-roll (worker
 * extraction, operator markup edits — one brain, codex review). Returns
 * composed offers from `active` rows ONLY when the rows fully cover the
 * profile's `placement.offer` data points; otherwise returns undefined so the
 * caller falls back to the legacy compose-from-data-points path:
 *
 *   - no rows at all → `legacy_fallback` (pre-backfill window);
 *   - PARTIAL coverage (deploy-before-backfill, interrupted backfill, an
 *     operator-entered `placement.offer` point with no row) → `legacy_partial`
 *     — switching to rows here would silently DROP the uncovered offers from
 *     the catalog, so the legacy path stays authoritative until coverage is
 *     complete.
 */
export async function composeOffersForRollup(
  tx: Tx,
  profileId: string,
  offerDataPointIds: string[],
  onSkipRow?: (rowId: string) => void,
): Promise<{ offers: PlacementOffer[] | undefined; source: OfferRollupSource }> {
  const rows = await tx.placementOfferRow.findMany({ where: { profileId } });
  if (rows.length === 0) return { offers: undefined, source: 'legacy_fallback' };
  const covered = new Set(rows.map((r) => r.sourceDataPointId).filter(Boolean));
  const fullCoverage = offerDataPointIds.every((id) => covered.has(id));
  if (!fullCoverage) return { offers: undefined, source: 'legacy_partial' };
  return { offers: composeOffersFromRows(rows, onSkipRow), source: 'offer_rows' };
}

/**
 * Re-derive + persist one profile's rolled-up fields from its data points,
 * composing `placementOffers` rows-aware (one brain for operator-markup
 * edits and the offer-renormalize worker — codex review: renormalization
 * MUST refresh the profile JSON the matcher/UI read, not just the rows).
 */
export async function rerollBloggerProfile(
  tx: Tx,
  profileId: string,
  onSkipRow?: (rowId: string) => void,
): Promise<{ source: OfferRollupSource }> {
  const points = await tx.profileDataPoint.findMany({ where: { profileId } });
  const rollupInput: RollupDataPoint[] = points.map((p) => ({
    field: p.field,
    value: p.value,
    unit: p.unit,
    confidence: Number(p.confidence),
    capturedAt: p.capturedAt,
  }));
  const composed = await composeOffersForRollup(
    tx,
    profileId,
    points.filter((p) => p.field === 'placement.offer').map((p) => p.id),
    onSkipRow,
  );
  const rolled = rollUpProfileFields(
    rollupInput,
    composed.offers ? { placementOffers: composed.offers } : undefined,
  );
  await tx.bloggerProfile.update({
    where: { id: profileId },
    data: {
      topics: rolled.topics,
      languages: rolled.languages,
      formats: rolled.formats,
      audience: rolled.audience as never,
      rateCards: rolled.rateCards as never,
      placementOffers: rolled.placementOffers as never,
      platformAudience: rolled.platformAudience as never,
      reach: rolled.reach,
      avgViews: rolled.avgViews,
      capturedAt: rolled.capturedAt ? new Date(rolled.capturedAt) : null,
    },
  });
  return { source: composed.source };
}

/**
 * Operator re-run supersede (no deletes): mark this message's live rows
 * `superseded` so the fresh re-extraction writes a new generation. Mirrors the
 * legacy data-point supersede scope — only LLM-origin rows of this profile +
 * source message.
 */
export async function supersedeOfferRowsForMessage(
  tx: Tx,
  opts: { profileId: string; sourceMessageId: string },
): Promise<number> {
  const res = await tx.placementOfferRow.updateMany({
    where: {
      profileId: opts.profileId,
      sourceMessageId: opts.sourceMessageId,
      status: { in: ['active', 'low_confidence'] },
    },
    data: { status: 'superseded' },
  });
  return res.count;
}
