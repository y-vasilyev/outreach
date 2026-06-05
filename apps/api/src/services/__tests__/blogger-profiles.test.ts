// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// bloggerProfilesService.get reads a profile with its dataPoints + mediaAssets
// via Prisma. We stub Prisma so we can assert the API-boundary mapping: (a)
// ProfileDataPoint.confidence (a Prisma Decimal — serialized as a string over
// the wire) is coerced to a JS number, and (b) mediaAssets are reduced to safe
// metadata only — never s3Key.
//
// Prisma's Decimal is modeled here as a string (its JSON serialization), which
// is exactly what the boundary coercion `Number(dp.confidence)` must handle.

interface PrismaMock {
  bloggerProfile: { findUnique: ReturnType<typeof vi.fn> };
  channel: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  message: { findMany: ReturnType<typeof vi.fn> };
}

const prismaMock: PrismaMock = {
  bloggerProfile: { findUnique: vi.fn() },
  channel: { findUnique: vi.fn(), findMany: vi.fn() },
  message: { findMany: vi.fn() },
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

import { bloggerProfilesService } from '../blogger-profiles.js';

const NOW = new Date('2026-05-20T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.channel.findUnique.mockResolvedValue(null);
  prismaMock.channel.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
  // Pin the clock so age-in-days assertions don't drift with the real wall clock.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bloggerProfilesService.get — API-boundary serialization', () => {
  it('coerces Decimal confidence to a JS number and exposes only safe media metadata', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p1',
      channelId: 'chan_1',
      topics: ['крипта'],
      languages: ['ru'],
      formats: ['пост'],
      audience: {},
      rateCards: [],
      reach: 1000,
      avgViews: 100,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [
        {
          id: 'dp1',
          profileId: 'p1',
          field: 'reach.subscribers',
          value: 1000,
          unit: null,
          confidence: '0.85',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '1k подписчиков',
          capturedAt: NOW,
          createdAt: NOW,
        },
      ],
      mediaAssets: [
        {
          id: 'a1',
          conversationId: 'c1',
          profileId: 'p1',
          kind: 'media_kit',
          s3Key: 'bloggers/p1/a1',
          mime: 'application/pdf',
          bytes: 2048,
          sha256: 'deadbeef',
          sourceTgMsgId: '42',
          createdAt: NOW,
        },
      ],
    });

    const out = await bloggerProfilesService.get('p1');

    // confidence is a real number, not a Decimal/string.
    expect(typeof out.dataPoints[0]?.confidence).toBe('number');
    expect(out.dataPoints[0]?.confidence).toBe(0.85);

    // mediaAssets carry safe metadata only.
    expect(out.mediaAssets).toEqual([
      { id: 'a1', kind: 'media_kit', mime: 'application/pdf', bytes: 2048, createdAt: NOW },
    ]);
    // No credential / object-store key leaks.
    expect(JSON.stringify(out.mediaAssets)).not.toContain('s3Key');
    expect((out.mediaAssets[0] as Record<string, unknown>).s3Key).toBeUndefined();
  });

  it('throws notFound for a missing profile', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValue(null);
    await expect(bloggerProfilesService.get('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns per-section freshness derived from the data points', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const profileCapturedAt = new Date(NOW.getTime() - 10 * DAY);
    const rateOld = new Date(NOW.getTime() - 120 * DAY); // > 90d → stale
    const audienceFresh = new Date(NOW.getTime() - 30 * DAY); // < 180d → fresh
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p2',
      channelId: 'chan_2',
      topics: ['food'],
      languages: ['ru'],
      formats: ['post'],
      audience: {},
      rateCards: [],
      reach: null,
      avgViews: null,
      capturedAt: profileCapturedAt,
      createdAt: profileCapturedAt,
      updatedAt: profileCapturedAt,
      dataPoints: [
        {
          id: 'dp_rate',
          profileId: 'p2',
          field: 'rate.post',
          value: 5000,
          unit: 'RUB',
          confidence: '0.9',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '',
          capturedAt: rateOld,
          createdAt: rateOld,
        },
        {
          id: 'dp_aud',
          profileId: 'p2',
          field: 'audience.geo',
          value: { RU: 0.9 },
          unit: null,
          confidence: '0.7',
          extractedBy: 'llm',
          sourceMessageId: null,
          rawSnippet: '',
          capturedAt: audienceFresh,
          createdAt: audienceFresh,
        },
      ],
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p2');
    expect(out.freshness.rateCards.stale).toBe(true);
    expect(out.freshness.rateCards.ageDays).toBe(120);
    expect(out.freshness.audience).toEqual({ stale: false, ageDays: 30 });
    // topics has no contributing data point → stale-by-default, no fallback
    // to profile.capturedAt (would otherwise be fresh-by-accident).
    expect(out.freshness.topics).toEqual({ stale: true, ageDays: null });
  });

  it('returns real multi-platform quote rate cards and their provenance rows', async () => {
    const rateCards = [
      { format: 'telegram_photo_post', price: 47000, currency: 'RUB' },
      { format: 'telegram_video_post', price: 53000, currency: 'RUB' },
      { format: 'telegram_round_text', price: 54000, currency: 'RUB' },
      { format: 'youtube_integration_first_slot', price: 65000, currency: 'RUB' },
      { format: 'youtube_shorts', price: 42000, currency: 'RUB' },
      { format: 'instagram_story_series', price: 37000, currency: 'RUB' },
      { format: 'instagram_reels', price: 87000, currency: 'RUB' },
      { format: 'vk_photo_post', price: 19000, currency: 'RUB' },
      { format: 'vk_clip', price: 22000, currency: 'RUB' },
    ];
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_live',
      channelId: 'chan_live',
      topics: [],
      languages: ['ru'],
      formats: rateCards.map((r) => r.format),
      audience: {},
      rateCards,
      reach: null,
      avgViews: null,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: rateCards.map((r, i) => ({
        id: `dp_live_${i}`,
        profileId: 'p_live',
        field: `rate.${r.format}`,
        value: r.price,
        unit: r.currency,
        confidence: '0.94',
        extractedBy: 'rate_card_extractor',
        sourceMessageId: 'm_live',
        rawSnippet: `${r.format} — ${r.price}`,
        capturedAt: NOW,
        createdAt: NOW,
      })),
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p_live');
    const outRateCards = out.rateCards as typeof rateCards;

    expect(outRateCards).toEqual(rateCards);
    expect(out.formats).toEqual(rateCards.map((r) => r.format));
    expect(out.dataPoints).toHaveLength(9);
    expect(out.dataPoints.find((d) => d.field === 'rate.instagram_reels')).toMatchObject({
      value: 87000,
      confidence: 0.94,
      extractedBy: 'rate_card_extractor',
      sourceMessageId: 'm_live',
    });
    expect(outRateCards.some((r) => r.format.includes('tiktok') || r.format.includes('tax'))).toBe(false);
  });

  it('repairs generic stored rates and exposes social profile links from the source message', async () => {
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

Бонусом кросс-постинг в Tik Tok — www.tiktok.com/@polyaamm
Статистика https://disk.yandex.ru/d/2BP6ZLLjtiLwyg`;
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_generic',
      channelId: 'chan_live',
      topics: [],
      languages: ['ru'],
      formats: ['integration', 'other', 'post', 'reels', 'story', 'video'],
      audience: {},
      rateCards: [
        { format: 'integration', price: 65000, currency: 'RUB' },
        { format: 'other', price: 54000, currency: 'RUB' },
        { format: 'post', price: 47000, currency: 'RUB' },
        { format: 'reels', price: 87000, currency: 'RUB' },
        { format: 'story', price: 37000, currency: 'RUB' },
        { format: 'video', price: 53000, currency: 'RUB' },
      ],
      reach: null,
      avgViews: null,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [
        {
          id: 'dp_generic',
          profileId: 'p_generic',
          field: 'rate.post',
          value: 47000,
          unit: 'RUB',
          confidence: '0.8',
          extractedBy: 'rate_card_extractor',
          sourceMessageId: 'm_live',
          rawSnippet: 'Фотопост — 47 000',
          capturedAt: NOW,
          createdAt: NOW,
        },
      ],
      mediaAssets: [],
    });
    prismaMock.channel.findUnique.mockResolvedValue({
      id: 'chan_live',
      platform: 'telegram',
      handle: 'fallback_channel',
      title: null,
      links: [],
    });
    prismaMock.message.findMany.mockResolvedValue([{ id: 'm_live', text: liveQuote }]);

    const out = await bloggerProfilesService.get('p_generic');

    expect(out.displayName).toBe('@polyaam');
    expect(out.socialLinks.map((l) => [l.platform, l.url])).toEqual([
      ['telegram', 'https://t.me/fallback_channel'],
      ['telegram', 'https://t.me/polyaam'],
      ['youtube', 'https://youtube.com/@polyaam'],
      ['instagram', 'https://instagram.com/polyaam'],
      ['vk', 'https://vk.com/club227874258'],
      ['tiktok', 'https://tiktok.com/@polyaamm'],
    ]);
    expect(out.rateCards).toEqual([
      { format: 'instagram_reels', price: 87000, currency: 'RUB' },
      { format: 'instagram_story_series', price: 37000, currency: 'RUB' },
      { format: 'telegram_photo_post', price: 47000, currency: 'RUB' },
      { format: 'telegram_round_text', price: 54000, currency: 'RUB' },
      { format: 'telegram_video_post', price: 53000, currency: 'RUB' },
      { format: 'vk_clip', price: 22000, currency: 'RUB' },
      { format: 'vk_photo_post', price: 19000, currency: 'RUB' },
      { format: 'youtube_integration_first_slot', price: 65000, currency: 'RUB' },
      { format: 'youtube_shorts', price: 42000, currency: 'RUB' },
    ]);
    expect(out.formats).toEqual(out.rateCards.map((r) => r.format));
  });
});
