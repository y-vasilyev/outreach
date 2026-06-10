import type { Prisma } from '@prisma/client';
import {
  decideOfferRowWrite,
  offerToRowFields,
  type PlacementOffer,
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
    select: { id: true, priceMin: true, currency: true, confidence: true, capturedAt: true },
  });

  const decision = decideOfferRowWrite(
    {
      priceMin: fields.priceMin,
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
