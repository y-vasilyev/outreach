import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * profile-extract worker — structured placement offers (entity-style-rate-cards
 * Section 2.3). When the `structured_placement_offers` flag is ON, the worker
 * dual-writes the extractor's `placement_offers` as `placement.offer`
 * ProfileDataPoint rows and `attribute_proposals` as `placement_attribute`
 * rows (status='proposed'), while keeping legacy `data_points` unchanged. When
 * the flag is OFF, behavior matches today exactly.
 *
 * These assertions do NOT depend on Section 3's rolled-up `placementOffers`
 * column (the roll-up returns it once Section 3 lands).
 */
const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    message: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bloggerProfile: { upsert: vi.fn(), update: vi.fn() },
    profileDataPoint: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    placementAttribute: { create: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    extractionHint: { findMany: vi.fn() },
    mediaAsset: { updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    placementOfferRow: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const runAgentSafe = vi.fn();
  const publishRealtime = vi.fn();
  const flagState: Record<string, boolean> = {};
  return { prisma, runAgentSafe, publishRealtime, flagState };
});

vi.mock('@nosquare/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nosquare/db')>();
  return { ...actual, getPrisma: () => mocks.prisma, Prisma: { JsonNull: null } };
});
vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));
vi.mock('../services/realtime-emit.js', () => ({ publishRealtime: mocks.publishRealtime }));
vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));

import { handleProfileExtract } from '../queues/profile-extract.js';

const PLACEMENT_OFFERS = [
  {
    kind: 'post',
    platform: 'telegram',
    price: 13000,
    currency: 'RUB',
    attributes: [{ key: 'duration', value: 'day', confidence: 0.95, rawSnippet: 'пост на сутки 13000' }],
    confidence: 0.96,
    rawSnippet: 'пост на сутки 13000',
  },
  {
    kind: 'post',
    platform: 'telegram',
    price: 21000,
    currency: 'RUB',
    attributes: [
      { key: 'duration', value: 'month', confidence: 0.95, rawSnippet: 'пост на месяц 21000' },
      { key: 'tax', value: 'налог 6%', confidence: 0.9, rawSnippet: 'налог 6%' },
    ],
    confidence: 0.96,
    rawSnippet: 'пост на месяц 21000',
  },
];

const ATTRIBUTE_PROPOSALS = [
  {
    suggestedKey: 'pinned_hours',
    suggestedType: 'number',
    applicableKinds: ['post'],
    evidence: ['24 часа в топе'],
    confidence: 0.7,
    rationale: 'часы закрепа',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.flagState)) delete mocks.flagState[k];
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    contact: { id: 'c1', channelId: 'ch1', channel: { id: 'ch1', title: 'X', language: 'ru' } },
  });
  mocks.prisma.message.findUnique.mockResolvedValue({
    id: 'm1',
    text: 'пост на сутки 13000, пост на месяц 21000 + налог 6%',
    conversationId: 'conv1',
    direction: 'in_',
  });
  mocks.prisma.bloggerProfile.upsert.mockResolvedValue({ id: 'prof1', channelId: 'ch1' });
  mocks.prisma.bloggerProfile.update.mockResolvedValue({});
  mocks.prisma.profileDataPoint.create.mockResolvedValue({ id: 'dp1' });
  mocks.prisma.profileDataPoint.findFirst.mockResolvedValue(null);
  mocks.prisma.profileDataPoint.findMany.mockResolvedValue([]);
  mocks.prisma.placementAttribute.create.mockResolvedValue({});
  mocks.prisma.placementAttribute.findFirst.mockResolvedValue(null);
  mocks.prisma.placementAttribute.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.profileDataPoint.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.extractionHint.findMany.mockResolvedValue([]);
  mocks.prisma.message.update.mockResolvedValue({});
  mocks.publishRealtime.mockResolvedValue(undefined);
  mocks.prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.mediaAsset.create.mockResolvedValue({});
  mocks.prisma.placementOfferRow.findFirst.mockResolvedValue(null);
  mocks.prisma.placementOfferRow.findMany.mockResolvedValue([]);
  mocks.prisma.placementOfferRow.create.mockResolvedValue({ id: 'or1' });
  mocks.prisma.placementOfferRow.update.mockResolvedValue({});
  mocks.prisma.placementOfferRow.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
  mocks.runAgentSafe.mockImplementation(async (name: string) => {
    if (name === 'rate_card_extractor') {
      return {
        data_points: [
          { field: 'rate.telegram_post_day', value: 13000, unit: 'RUB', confidence: 0.96, rawSnippet: 'пост на сутки 13000' },
          { field: 'rate.telegram_post_month', value: 21000, unit: 'RUB', confidence: 0.96, rawSnippet: 'пост на месяц 21000' },
        ],
        placement_offers: PLACEMENT_OFFERS,
        attribute_proposals: ATTRIBUTE_PROPOSALS,
      };
    }
    return { data_points: [] };
  });
});

describe('handleProfileExtract — structured placement offers', () => {
  it('writes placement.offer rows + proposals even when the flag is OFF (canonical write path)', async () => {
    // harden-reply-extraction D3: structured persistence no longer depends on
    // `structured_placement_offers`. With the flag OFF the catalog is still
    // structurally complete; the flag now governs matching/planner preference.
    mocks.flagState.structured_placement_offers = false;
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    const created = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string } }).data,
    );
    // Structured offers persisted (2 distinct) AND legacy dual-write rows.
    expect(created.filter((d) => d.field === 'placement.offer')).toHaveLength(2);
    expect(created.some((d) => d.field === 'rate.telegram_post_day')).toBe(true);
    // Attribute proposals persisted regardless of the flag.
    expect(mocks.prisma.placementAttribute.create).toHaveBeenCalledTimes(1);
  });

  it('writes placement.offer rows + proposals when the flag is ON', async () => {
    mocks.flagState.structured_placement_offers = true;
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    const created = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string; value: unknown; sourceMessageId: string; rawSnippet: string } }).data,
    );
    const offerRows = created.filter((d) => d.field === 'placement.offer');
    // Two distinct offers (day + month) → two rows; day vs month not collapsed.
    expect(offerRows).toHaveLength(2);
    expect(offerRows.every((d) => d.sourceMessageId === 'm1')).toBe(true);

    // Provenance was stamped onto the persisted offer value.
    const values = offerRows.map((d) => d.value as Record<string, unknown>);
    expect(values.every((v) => v.sourceMessageId === 'm1')).toBe(true);
    expect(values.every((v) => v.extractedBy === 'rate_card_extractor')).toBe(true);
    expect(values.every((v) => typeof v.capturedAt === 'string')).toBe(true);

    // Tax is an attribute on the month offer; never a separate offer row.
    const durations = values
      .map((v) => (v.attributes as Array<{ key: string; value: unknown }>).find((a) => a.key === 'duration')?.value)
      .sort();
    expect(durations).toEqual(['day', 'month']);
    const monthOffer = values.find((v) =>
      (v.attributes as Array<{ key: string; value: unknown }>).some((a) => a.key === 'duration' && a.value === 'month'),
    );
    expect(
      (monthOffer?.attributes as Array<{ key: string }>).some((a) => a.key === 'tax'),
    ).toBe(true);

    // Legacy data points still written (dual-write).
    expect(created.some((d) => d.field === 'rate.telegram_post_day')).toBe(true);

    // Proposal persisted as a placement_attribute row (status='proposed').
    expect(mocks.prisma.placementAttribute.create).toHaveBeenCalledTimes(1);
    const proposalData = (
      mocks.prisma.placementAttribute.create.mock.calls[0]![0] as {
        data: { key: string; status: string; sourceMessageId: string; valueType: string };
      }
    ).data;
    expect(proposalData.key).toBe('pinned_hours');
    expect(proposalData.status).toBe('proposed');
    expect(proposalData.sourceMessageId).toBe('m1');
    expect(proposalData.valueType).toBe('number');
  });

  it('persists structured-only extraction (no legacy data_points) instead of dropping it', async () => {
    // Regression: the worker short-circuited on `drafts.length === 0` BEFORE
    // reading placement_offers/attribute_proposals, so an extractor that
    // correctly returned only a structured offer (e.g. "пост 50000 + условия")
    // with no legacy `data_points` persisted NOTHING.
    mocks.flagState.structured_placement_offers = true;
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') {
        return {
          data_points: [], // structured-only — no legacy rows
          placement_offers: [
            {
              kind: 'post',
              platform: null,
              price: 50000,
              currency: 'RUB',
              attributes: [],
              confidence: 0.9,
              rawSnippet: 'стоимость рекламного поста 50 тыс рублей',
            },
          ],
          attribute_proposals: ATTRIBUTE_PROPOSALS,
        };
      }
      return { data_points: [] };
    });

    const result = await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    // The early-return path was NOT taken: the profile was upserted/rolled up.
    expect(mocks.prisma.bloggerProfile.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledTimes(1);
    expect(result).not.toMatchObject({ dataPoints: 0 });

    const created = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string } }).data,
    );
    const offerRows = created.filter((d) => d.field === 'placement.offer');
    expect(offerRows).toHaveLength(1);
    // The unknown-attribute proposal was persisted too.
    expect(mocks.prisma.placementAttribute.create).toHaveBeenCalledTimes(1);
  });

  it('still short-circuits when there is genuinely nothing to persist', async () => {
    mocks.flagState.structured_placement_offers = true;
    mocks.runAgentSafe.mockResolvedValue({
      data_points: [],
      placement_offers: [],
      attribute_proposals: [],
    });

    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    expect(mocks.prisma.bloggerProfile.upsert).not.toHaveBeenCalled();
    expect(mocks.prisma.profileDataPoint.create).not.toHaveBeenCalled();
    expect(mocks.prisma.placementAttribute.create).not.toHaveBeenCalled();
  });

  it('is idempotent: skips existing placement.offer rows and proposals on re-run', async () => {
    mocks.flagState.structured_placement_offers = true;
    // Simulate everything already persisted.
    mocks.prisma.profileDataPoint.findFirst.mockResolvedValue({ id: 'existing' });
    mocks.prisma.placementAttribute.findFirst.mockResolvedValue({ id: 'existing' });

    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    const created = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string } }).data,
    );
    expect(created.some((d) => d.field === 'placement.offer')).toBe(false);
    expect(mocks.prisma.placementAttribute.create).not.toHaveBeenCalled();
  });

  it('supersede deletes prior rows (not operator points) before writing', async () => {
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1', supersede: true });
    // Prior data points for this message deleted, excluding operator origin.
    const del = mocks.prisma.profileDataPoint.deleteMany.mock.calls[0]![0] as {
      where: { profileId: string; sourceMessageId: string; extractedBy: { not: string } };
    };
    expect(del.where.sourceMessageId).toBe('m1');
    expect(del.where.extractedBy.not).toBe('operator');
    // Prior PROPOSED attribute proposals + raw-payload media deleted; an
    // admin-approved `active` registry row is preserved (status filter).
    expect(mocks.prisma.placementAttribute.deleteMany).toHaveBeenCalledWith({
      where: { sourceMessageId: 'm1', status: 'proposed' },
    });
    expect(mocks.prisma.mediaAsset.deleteMany).toHaveBeenCalled();
  });

  it('supersede with an EMPTY re-extraction still clears the prior rows (codex P2.2)', async () => {
    mocks.runAgentSafe.mockResolvedValue({ data_points: [], placement_offers: [], attribute_proposals: [] });
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1', supersede: true });
    // Entered the tx and cleared old rows even though nothing new was extracted.
    expect(mocks.prisma.profileDataPoint.deleteMany).toHaveBeenCalled();
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalled(); // re-rolled
    const stamped = mocks.prisma.message.update.mock.calls.find(
      (c) => (c[0] as { data: { extractionStatus?: string } }).data.extractionStatus === 'empty',
    );
    expect(stamped).toBeTruthy();
  });

  it('does NOT delete prior rows when supersede is absent', async () => {
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    expect(mocks.prisma.profileDataPoint.deleteMany).not.toHaveBeenCalled();
  });

  it('stamps extractionStatus ok on a successful write', async () => {
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    const okCall = mocks.prisma.message.update.mock.calls.find(
      (c) => (c[0] as { data: { extractionStatus?: string } }).data.extractionStatus === 'ok',
    );
    expect(okCall).toBeTruthy();
    // And emits the realtime status event.
    expect(
      mocks.publishRealtime.mock.calls.some(
        (c) => (c[1] as { type?: string }).type === 'message.extraction_status.changed',
      ),
    ).toBe(true);
  });

  it('passes operator hints into the extractor input', async () => {
    mocks.prisma.extractionHint.findMany.mockResolvedValue([
      { guidance: 'МАХ = MAX messenger', exampleInput: null, exampleOutput: null, targetField: 'platform' },
    ]);
    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    const rateCall = mocks.runAgentSafe.mock.calls.find((c) => c[0] === 'rate_card_extractor');
    const input = rateCall![1] as { operator_hints?: string[] };
    expect(input.operator_hints?.[0]).toContain('МАХ = MAX messenger');
  });
});
