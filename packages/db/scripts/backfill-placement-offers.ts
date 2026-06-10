import { PlacementOfferZ } from '@nosquare/shared';
import { getPrisma } from '../src/index.js';
import { persistPlacementOfferRow } from '../src/placement-offer-rows.js';

/**
 * One-shot, idempotent backfill (placement-offer-table, task 4.1):
 * convert existing `placement.offer` ProfileDataPoint rows into first-class
 * `placement_offer` rows.
 *
 * Chronological replay: per profile, points are processed in `capturedAt` (then
 * `createdAt`) order through the SAME `persistPlacementOfferRow` helper the
 * worker dual-write uses, so supersede chains come out exactly as if dual-write
 * had always been on. Idempotency on (profileId, sourceDataPointId) makes
 * re-runs and overlap with live dual-write safe (`skipped`).
 *
 * Unparseable historical JSON is logged with row ids and skipped —
 * `profile_data_point` is never modified by this script.
 *
 * Run: `pnpm db:backfill:offers`
 */
async function main(): Promise<void> {
  const prisma = getPrisma();

  const profileIds = (
    await prisma.profileDataPoint.findMany({
      where: { field: 'placement.offer' },
      select: { profileId: true },
      distinct: ['profileId'],
    })
  ).map((r) => r.profileId);

  console.log(`[backfill-placement-offers] profiles with offer points: ${profileIds.length}`);

  let created = 0;
  let skipped = 0;
  let unparseable = 0;

  for (const profileId of profileIds) {
    const points = await prisma.profileDataPoint.findMany({
      where: { profileId, field: 'placement.offer' },
      orderBy: [{ capturedAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        value: true,
        capturedAt: true,
        sourceMessageId: true,
        extractedBy: true,
      },
    });
    // One transaction per profile keeps each profile's chain atomic without
    // holding a single giant transaction across the whole catalog.
    await prisma.$transaction(async (tx) => {
      for (const point of points) {
        const parsed = PlacementOfferZ.safeParse(point.value);
        if (!parsed.success) {
          unparseable += 1;
          console.warn(
            `[backfill-placement-offers] unparseable offer JSON: profile=${profileId} dataPoint=${point.id} — skipped (data point untouched)`,
          );
          continue;
        }
        // Provenance fallback: offers whose stored JSON lacks embedded
        // provenance (operator-entered values, older drafts) must inherit the
        // DATA POINT's capturedAt/sourceMessageId/extractedBy — otherwise the
        // history would show the backfill run's date and 'llm' ownership
        // (codex review). Zod defaults can't tell "absent" from "explicit",
        // so check the raw JSON for extractedBy.
        const offer = parsed.data;
        if (!offer.capturedAt) offer.capturedAt = point.capturedAt.toISOString();
        if (!offer.sourceMessageId) offer.sourceMessageId = point.sourceMessageId;
        const rawValue = point.value as Record<string, unknown> | null;
        if (rawValue && typeof rawValue === 'object' && rawValue['extractedBy'] === undefined) {
          offer.extractedBy = point.extractedBy;
        }
        const res = await persistPlacementOfferRow(tx, {
          profileId,
          offer,
          sourceDataPointId: point.id,
        });
        if (res === 'created') created += 1;
        else skipped += 1;
      }
    });
  }

  const totalRows = await prisma.placementOfferRow.count();
  const totalPoints = await prisma.profileDataPoint.count({
    where: { field: 'placement.offer' },
  });
  console.log(
    `[backfill-placement-offers] done: created=${created} skipped=${skipped} unparseable=${unparseable}; ` +
      `placement_offer rows=${totalRows} vs placement.offer data points=${totalPoints}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-placement-offers] failed:', err);
    process.exit(1);
  });
