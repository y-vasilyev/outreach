import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * profile-extract worker (agency-sourcing-matching M5, task 5.2/5.5): runs the
 * two extractors, persists data points linked to the channel's BloggerProfile
 * (created on first sight), attributes them to the inbound Message.id, and
 * re-derives the standardized profile via the deterministic roll-up.
 */
const mocks = vi.hoisted(() => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    message: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    bloggerProfile: { upsert: vi.fn(), update: vi.fn() },
    profileDataPoint: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    placementAttribute: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    extractionHint: { findMany: vi.fn() },
    // harden-agency-sourcing-pipeline: profile-extract backfills
    // pre-profile media assets when the catalog profile appears.
    mediaAsset: { updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  };
  const runAgentSafe = vi.fn();
  const publishRealtime = vi.fn();
  // Feature flag mock — tests can flip object_storage etc. via this state.
  const flagState: Record<string, boolean> = {};
  return { prisma, runAgentSafe, publishRealtime, flagState };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma, Prisma: { JsonNull: null } }));
vi.mock('bullmq', () => ({ Worker: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../services/run-agent-safe.js', () => ({ runAgentSafe: mocks.runAgentSafe }));
vi.mock('../services/realtime-emit.js', () => ({ publishRealtime: mocks.publishRealtime }));
vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));

import { handleProfileExtract } from '../queues/profile-extract.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.conversation.findUnique.mockResolvedValue({
    id: 'conv1',
    contact: { id: 'c1', channelId: 'ch1', channel: { id: 'ch1', title: 'X', language: 'ru' } },
  });
  mocks.prisma.message.findMany.mockResolvedValue([
    { id: 'm1', text: 'пост 15000', direction: 'in_', createdAt: new Date('2026-05-01T00:00:00Z') },
    { id: 'm2', text: 'охваты сторис 12к', direction: 'in_', createdAt: new Date('2026-05-02T00:00:00Z') },
  ]);
  // S1: no sourceMessageId in the job → fall back to the latest inbound.
  mocks.prisma.message.findFirst.mockResolvedValue({
    id: 'm2',
    text: 'пост 15000, охваты сторис 12к',
  });
  // S1: explicit sourceMessageId → extract from + attribute to that message.
  mocks.prisma.message.findUnique.mockResolvedValue({
    id: 'm1',
    text: 'пост 15000, охваты сторис 12к',
    conversationId: 'conv1',
    direction: 'in_',
  });
  mocks.prisma.bloggerProfile.upsert.mockResolvedValue({ id: 'prof1', channelId: 'ch1' });
  mocks.prisma.bloggerProfile.update.mockResolvedValue({});
  mocks.prisma.profileDataPoint.create.mockResolvedValue({});
  mocks.prisma.profileDataPoint.findFirst.mockResolvedValue(null);
  mocks.prisma.profileDataPoint.findMany.mockResolvedValue([]);
  mocks.prisma.profileDataPoint.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.placementAttribute.findFirst.mockResolvedValue(null);
  mocks.prisma.placementAttribute.create.mockResolvedValue({});
  mocks.prisma.placementAttribute.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.extractionHint.findMany.mockResolvedValue([]);
  mocks.prisma.message.update.mockResolvedValue({});
  mocks.publishRealtime.mockResolvedValue(undefined);
  mocks.prisma.mediaAsset.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 0 });
  mocks.prisma.mediaAsset.create.mockResolvedValue({});
  mocks.prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mocks.prisma) => Promise<unknown>) => fn(mocks.prisma),
  );
});

describe('handleProfileExtract', () => {
  it('persists data points from both extractors and rolls up the profile', async () => {
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') {
        return { data_points: [{ field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, rawSnippet: 'пост 15000' }] };
      }
      if (name === 'audience_stats_extractor') {
        return { data_points: [{ field: 'reach.story', value: 12000, confidence: 0.85, rawSnippet: 'охваты сторис 12к' }] };
      }
      return null;
    });
    // The roll-up reads back all persisted points.
    mocks.prisma.profileDataPoint.findMany.mockResolvedValue([
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: new Date('2026-05-02T00:00:00Z') },
      { field: 'reach.story', value: 12000, unit: null, confidence: 0.85, capturedAt: new Date('2026-05-02T00:00:00Z') },
    ]);

    const result = await handleProfileExtract({ conversationId: 'conv1' });

    // Profile created/looked up by channelId.
    expect(mocks.prisma.bloggerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channelId: 'ch1' } }),
    );
    // Both data points persisted, attributed to the latest inbound message.
    expect(mocks.prisma.profileDataPoint.create).toHaveBeenCalledTimes(2);
    const createdFields = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { field: string; sourceMessageId: string } }).data,
    );
    expect(createdFields.map((d) => d.field).sort()).toEqual(['rate.post', 'reach.story']);
    expect(createdFields.every((d) => d.sourceMessageId === 'm2')).toBe(true);
    // Roll-up wrote the standardized fields onto the profile.
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prof1' },
        data: expect.objectContaining({
          reach: 12000,
          rateCards: [{ format: 'post', price: 15000, currency: 'RUB' }],
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, profileId: 'prof1', dataPointsCreated: 2 });
  });

  it('fills the blogger profile rate card from a real multi-platform quote', async () => {
    const liveQuote = `Юрий, добрый день!

*налог на ИП включен

Telegram — https://t.me/polyaam
*1 месяц, 2-3 часа в топе
Фотопост — 47 000
Видеопост — 53 000
Кружок + текст — 54 000

YouTube — https://youtube.com/@polyaam
Интеграция 60-120 секунд (первый слот) — 65 000
Shorts — 42 000

Instagram — https://instagram.com/polyaam?igshid=YmMyMTA2M2Y
Серия сторис — 37 000
Рилс — 87 000

ВКонтакте — https://vk.com/club227874258
Фото-пост — 19 000
ВК-клип — 22 000

Бонусом кросс-постинг в Tik Tok — www.tiktok.com/@polyaamm Статистика https://disk.yandex.ru/d/2BP6ZLLjtiLwyg`;
    const ratePoints = [
      { field: 'rate.telegram_photo_post', value: 47000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Фотопост — 47 000' },
      { field: 'rate.telegram_video_post', value: 53000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Видеопост — 53 000' },
      { field: 'rate.telegram_round_text', value: 54000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Кружок + текст — 54 000' },
      { field: 'rate.youtube_integration_first_slot', value: 65000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Интеграция 60-120 секунд (первый слот) — 65 000' },
      { field: 'rate.youtube_shorts', value: 42000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Shorts — 42 000' },
      { field: 'rate.instagram_story_series', value: 37000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Серия сторис — 37 000' },
      { field: 'rate.instagram_reels', value: 87000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Рилс — 87 000' },
      { field: 'rate.vk_photo_post', value: 19000, unit: 'RUB', confidence: 0.94, rawSnippet: 'Фото-пост — 19 000' },
      { field: 'rate.vk_clip', value: 22000, unit: 'RUB', confidence: 0.94, rawSnippet: 'ВК-клип — 22 000' },
    ];
    mocks.prisma.message.findUnique.mockResolvedValue({
      id: 'm_live',
      text: liveQuote,
      conversationId: 'conv1',
      direction: 'in_',
    });
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') return { data_points: ratePoints };
      return { data_points: [] };
    });
    mocks.prisma.profileDataPoint.findMany.mockResolvedValue(
      ratePoints.map((p) => ({ ...p, capturedAt: new Date('2026-06-04T10:00:00Z') })),
    );

    const result = await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm_live' });

    expect(mocks.prisma.profileDataPoint.create).toHaveBeenCalledTimes(9);
    expect(
      mocks.prisma.profileDataPoint.create.mock.calls.every(
        (c) => (c[0] as { data: { sourceMessageId: string } }).data.sourceMessageId === 'm_live',
      ),
    ).toBe(true);
    expect(mocks.prisma.bloggerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prof1' },
        data: expect.objectContaining({
          rateCards: [
            { format: 'instagram_reels', price: 87000, currency: 'RUB' },
            { format: 'instagram_story_series', price: 37000, currency: 'RUB' },
            { format: 'telegram_photo_post', price: 47000, currency: 'RUB' },
            { format: 'telegram_round_text', price: 54000, currency: 'RUB' },
            { format: 'telegram_video_post', price: 53000, currency: 'RUB' },
            { format: 'vk_clip', price: 22000, currency: 'RUB' },
            { format: 'vk_photo_post', price: 19000, currency: 'RUB' },
            { format: 'youtube_integration_first_slot', price: 65000, currency: 'RUB' },
            { format: 'youtube_shorts', price: 42000, currency: 'RUB' },
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, profileId: 'prof1', dataPointsCreated: 9 });
  });

  it('attributes data points to the explicit triggering message (S1 provenance)', async () => {
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') {
        return { data_points: [{ field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, rawSnippet: 'x' }] };
      }
      return { data_points: [] };
    });
    mocks.prisma.profileDataPoint.findMany.mockResolvedValue([
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    // findUnique resolved the specific inbound; points attributed to it.
    expect(mocks.prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1' } }),
    );
    expect(mocks.prisma.message.findFirst).not.toHaveBeenCalled();
    const created = mocks.prisma.profileDataPoint.create.mock.calls.map(
      (c) => (c[0] as { data: { sourceMessageId: string } }).data,
    );
    expect(created.every((d) => d.sourceMessageId === 'm1')).toBe(true);
  });

  it('skips when the contact has no channel', async () => {
    mocks.prisma.conversation.findUnique.mockResolvedValue({
      id: 'conv1',
      contact: { id: 'c1', channelId: null, channel: null },
    });
    const result = await handleProfileExtract({ conversationId: 'conv1' });
    expect(result).toMatchObject({ skipped: 'no_channel' });
    expect(mocks.prisma.bloggerProfile.upsert).not.toHaveBeenCalled();
  });

  it('pre-gate skips inbound with no commercial signal (no LLM calls)', async () => {
    // harden-agency-sourcing-pipeline: turns like "ок, в пятницу" must NOT
    // burn the two extractor LLM calls.
    mocks.prisma.message.findUnique.mockResolvedValue({
      id: 'm1',
      text: 'ок, договорились',
      conversationId: 'conv1',
      direction: 'in_',
    });
    const result = await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    expect(result).toMatchObject({ skipped: 'no_signal' });
    expect(mocks.runAgentSafe).not.toHaveBeenCalled();
  });

  it('pre-gate passes inbounds with a keyword but no digit (review fix: OR not AND)', async () => {
    // Bloggers routinely write "прайс отправлю", "медиакит во вложении",
    // "стоимость пятнадцать тысяч". Pre-gate must let those through; the
    // earlier `digit AND keyword` predicate dropped them silently.
    mocks.prisma.message.findUnique.mockResolvedValue({
      id: 'm1',
      text: 'прайс отправлю в личку',
      conversationId: 'conv1',
      direction: 'in_',
    });
    mocks.runAgentSafe.mockImplementation(async () => ({ data_points: [] }));
    const result = await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });
    expect(result).not.toMatchObject({ skipped: 'no_signal' });
    expect(mocks.runAgentSafe).toHaveBeenCalled();
  });

  it('throws when ANY extractor fails (so BullMQ retries / sync caller logs)', async () => {
    // harden-agency-sourcing-pipeline review fix: previously throw was gated
    // on BOTH extractors failing — meaning a successful audience extractor
    // would mask a failed rate_card_extractor and silently lose the price.
    // Now any null from `runAgentSafe` throws and the whole job is retried.
    mocks.runAgentSafe.mockResolvedValue(null);
    await expect(
      handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' }),
    ).rejects.toThrow(/extractors failed/i);
  });

  it('throws even when one extractor succeeded but the other failed', async () => {
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') return null;
      return { data_points: [] };
    });
    await expect(
      handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' }),
    ).rejects.toThrow(/rate_card_extractor/);
  });

  it('returns success with zero data points when extractors returned cleanly but empty', async () => {
    mocks.runAgentSafe.mockImplementation(async () => ({ data_points: [] }));
    const result = await handleProfileExtract({
      conversationId: 'conv1',
      sourceMessageId: 'm1',
    });
    expect(result).toMatchObject({ ok: true, channelId: 'ch1', dataPoints: 0 });
    expect(mocks.prisma.profileDataPoint.create).not.toHaveBeenCalled();
  });

  it('backfills mediaAsset.profileId for pre-profile assets on the same conversation', async () => {
    mocks.runAgentSafe.mockImplementation(async (name: string) => {
      if (name === 'rate_card_extractor') {
        return {
          data_points: [
            { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, rawSnippet: 'пост 15000' },
          ],
        };
      }
      return { data_points: [] };
    });
    mocks.prisma.profileDataPoint.findMany.mockResolvedValue([
      { field: 'rate.post', value: 15000, unit: 'RUB', confidence: 0.9, capturedAt: new Date() },
    ]);

    await handleProfileExtract({ conversationId: 'conv1', sourceMessageId: 'm1' });

    expect(mocks.prisma.mediaAsset.updateMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv1', profileId: null },
      data: { profileId: 'prof1' },
    });
  });
});
