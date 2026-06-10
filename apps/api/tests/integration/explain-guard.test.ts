import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@nosquare/db';

/**
 * EXPLAIN-guard (catalog-sql-search 2.4): the hot offer-search queries must
 * use the 9f/9g indexes — a seq scan over `placement_offer` at catalog scale
 * means a dropped index or a broken predicate shape.
 *
 * Needs a REAL Postgres with migrations applied. Skipped unless
 * `EXPLAIN_GUARD_DB_URL` is set (CI without a DB harness skips silently):
 *
 *   docker run -d --rm --name eg-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=outreach -p 127.0.0.1:55450:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:test@localhost:55450/outreach \
 *     pnpm --filter @nosquare/db prisma:migrate:deploy
 *   EXPLAIN_GUARD_DB_URL=postgresql://postgres:test@localhost:55450/outreach \
 *     npx vitest run tests/integration/explain-guard.test.ts
 */

const DB_URL = process.env['EXPLAIN_GUARD_DB_URL'];
const SEED_PROFILES = 300;
const OFFERS_PER_PROFILE = 4;

const d = describe.skipIf(!DB_URL);

let prisma: PrismaClient;

function planNodes(plan: unknown): string[] {
  // Flatten "Node Type" values out of an EXPLAIN (FORMAT JSON) tree.
  const out: string[] = [];
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node) return;
    const t = node['Node Type'];
    const rel = node['Relation Name'];
    if (typeof t === 'string') out.push(rel ? `${t}:${rel}` : t);
    const children = node['Plans'];
    if (Array.isArray(children)) for (const c of children) walk(c as Record<string, unknown>);
  };
  const root = (plan as Array<{ Plan: Record<string, unknown> }>)[0]?.Plan;
  walk(root);
  return out;
}

async function explain(sql: string): Promise<string[]> {
  // Index-SHAPE guard, not a planner benchmark: at seed scale (~1.2k rows) a
  // seq scan is often genuinely optimal, so we disable it for the session —
  // any remaining Seq Scan means NO index can serve the predicate at all
  // (dropped index / broken query shape), which is exactly what we guard.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown }>>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
    );
  });
  return planNodes(rows[0]!['QUERY PLAN']);
}

d('EXPLAIN-guard: placement_offer hot queries use 9f/9g indexes', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL! } } });
    // Idempotent seed: a catalog big enough that the planner prefers indexes.
    const count = await prisma.placementOfferRow.count();
    if (count < SEED_PROFILES * OFFERS_PER_PROFILE) {
      for (let p = 0; p < SEED_PROFILES; p++) {
        const profile = await prisma.bloggerProfile.upsert({
          where: { channelId: `eg_ch_${p}` },
          update: {},
          create: { channelId: `eg_ch_${p}` },
        });
        const rows = Array.from({ length: OFFERS_PER_PROFILE }, (_, i) => ({
          profileId: profile.id,
          platform: ['telegram', 'instagram', 'youtube', 'vk'][i % 4]!,
          kind: ['post', 'story', 'integration', 'video'][i % 4]!,
          priceMin: 10000 + p * 100 + i,
          priceMax: 10000 + p * 100 + i,
          priceRubMin: 10000 + p * 100 + i,
          priceRubMax: 10000 + p * 100 + i,
          cpmRub: 100 + (p % 50),
          currency: 'RUB',
          identityKey: `eg|${p}|${i}`,
          status: 'active',
          confidence: 0.9,
          rawSnippet: `eg seed ${p}/${i}`,
          sourceDataPointId: `eg_dp_${p}_${i}`,
          capturedAt: new Date(),
        }));
        await prisma.placementOfferRow.createMany({ data: rows, skipDuplicates: true });
      }
      await prisma.$executeRawUnsafe('ANALYZE placement_offer');
      await prisma.$executeRawUnsafe('ANALYZE blogger_profile');
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('catalog filter (EXISTS active offers per profile) hits the profile_id index, no seq scan', async () => {
    const nodes = await explain(`
      SELECT bp.id FROM blogger_profile bp
      WHERE EXISTS (
        SELECT 1 FROM placement_offer o
        WHERE o.profile_id = bp.id
          AND o.status = 'active'
          AND o.platform ILIKE 'telegram'
          AND o.kind ILIKE 'post'
          AND (o.price_rub_min <= 50000
               OR (o.price_rub_min IS NULL AND o.currency ILIKE 'RUB' AND o.price_min <= 50000))
      )`);
    expect(nodes.some((n) => n.startsWith('Seq Scan:placement_offer'))).toBe(false);
    expect(nodes.some((n) => /Index.*placement_offer/.test(n) || n.includes('Bitmap Heap Scan:placement_offer'))).toBe(true);
  });

  it('matching pre-cut (budget superset) avoids a placement_offer seq scan', async () => {
    const nodes = await explain(`
      SELECT bp.id FROM blogger_profile bp
      WHERE NOT EXISTS (
        SELECT 1 FROM placement_offer o WHERE o.profile_id = bp.id AND o.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM placement_offer o
        WHERE o.profile_id = bp.id AND o.status = 'active'
          AND (o.price_rub_min <= 30000
               OR (o.price_rub_min IS NULL AND o.currency ILIKE 'RUB' AND o.price_min <= 30000)
               OR (o.price_rub_min IS NULL AND o.currency ILIKE 'RUB' AND o.price_min IS NULL)
               OR (o.price_rub_min IS NULL AND o.currency NOT ILIKE 'RUB'))
      )`);
    expect(nodes.some((n) => n.startsWith('Seq Scan:placement_offer'))).toBe(false);
  });

  it('active-CPM partial index serves the cpm cap', async () => {
    const nodes = await explain(
      `SELECT o.profile_id FROM placement_offer o WHERE o.status = 'active' AND o.cpm_rub <= 120`,
    );
    expect(nodes.some((n) => n.startsWith('Seq Scan:placement_offer'))).toBe(false);
  });
});
