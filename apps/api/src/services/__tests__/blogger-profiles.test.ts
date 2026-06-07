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
  bloggerProfile: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  adBrief: { findUnique: ReturnType<typeof vi.fn> };
  campaign: { findUnique: ReturnType<typeof vi.fn> };
  matchResult: { findMany: ReturnType<typeof vi.fn> };
  channel: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  message: { findMany: ReturnType<typeof vi.fn> };
}

const prismaMock: PrismaMock = {
  bloggerProfile: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
  adBrief: { findUnique: vi.fn() },
  campaign: { findUnique: vi.fn() },
  matchResult: { findMany: vi.fn() },
  channel: { findUnique: vi.fn(), findMany: vi.fn() },
  message: { findMany: vi.fn() },
};

vi.mock('@nosquare/db', () => ({
  getPrisma: () => prismaMock,
}));

vi.mock('../../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: () => false }),
}));

const channelScrapeAdd = vi.fn();
vi.mock('../../queues.js', () => ({
  getQueues: () => ({ channelScrape: { add: channelScrapeAdd } }),
}));

import { bloggerProfilesService } from '../blogger-profiles.js';

const NOW = new Date('2026-05-20T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.channel.findUnique.mockResolvedValue(null);
  prismaMock.channel.findMany.mockResolvedValue([]);
  prismaMock.message.findMany.mockResolvedValue([]);
  prismaMock.bloggerProfile.count.mockResolvedValue(0);
  prismaMock.bloggerProfile.findMany.mockResolvedValue([]);
  prismaMock.bloggerProfile.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'p_update',
    ...data,
  }));
  prismaMock.adBrief.findUnique.mockResolvedValue(null);
  prismaMock.campaign.findUnique.mockResolvedValue(null);
  prismaMock.matchResult.findMany.mockResolvedValue([]);
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

  it('serializes bounded post insights with independent metric freshness', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_posts',
      channelId: null,
      topics: ['финтех'],
      languages: ['ru'],
      formats: ['post'],
      audience: {},
      rateCards: [],
      placementOffers: [],
      reach: null,
      avgViews: 10000,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      postInsightRefreshStatus: 'idle',
      postInsightRefreshError: null,
      postInsightRefreshedAt: null,
      postInsights: [
        {
          id: 'post1',
          profileId: 'p_posts',
          channelId: null,
          platform: 'telegram',
          externalPostId: '42',
          url: 'https://t.me/test/42',
          publishedAt: new Date('2026-05-19T00:00:00Z'),
          textSnippet: 'финтех пост',
          mediaKind: 'post',
          metrics: { views: 20000, reactions: 100 },
          metricCapturedAt: new Date('2026-05-19T00:00:00Z'),
          source: 'telegram_public_parse',
          sourceRawRef: 'telegram:1:42',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      dataPoints: [],
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p_posts');
    expect(out.postInsights).toHaveLength(1);
    expect(out.topPostsPreview).toHaveLength(1);
    expect(out.postInsights[0]!.metrics.views).toBe(20000);
    expect(out.postInsights[0]!.freshness).toEqual({ state: 'fresh', ageDays: 1 });
    expect(out.postInsights[0]!.performanceScore).toBeGreaterThan(0);
  });

  it('keeps legacy list responses compatible when no fit context or post insights exist', async () => {
    prismaMock.bloggerProfile.count.mockResolvedValue(1);
    prismaMock.bloggerProfile.findMany.mockResolvedValue([
      {
        id: 'p_list',
        channelId: null,
        topics: [],
        languages: [],
        formats: [],
        audience: {},
        rateCards: [],
        placementOffers: [],
        reach: null,
        avgViews: null,
        capturedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        postInsightRefreshStatus: 'idle',
        postInsightRefreshError: null,
        postInsightRefreshedAt: null,
        dataPoints: [],
        postInsights: [],
        _count: { dataPoints: 0 },
      },
    ]);
    const out = await bloggerProfilesService.list({ limit: 50 });
    expect(out.total).toBe(1);
    expect(out.items[0]!.topPostsPreview).toEqual([]);
    expect((out.items[0] as { fit?: unknown }).fit).toBeUndefined();
  });

  it('rejects ambiguous catalog fit context', async () => {
    await expect(
      bloggerProfilesService.list({ campaignId: 'camp1', briefId: 'brief1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('uses persisted match result for brief context', async () => {
    prismaMock.adBrief.findUnique.mockResolvedValue({
      id: 'brief1',
      topic: 'финтех',
      audienceTarget: '',
      budget: null,
      formats: [],
      geo: [],
      deadline: null,
      notes: '',
      createdAt: NOW,
    });
    prismaMock.bloggerProfile.count.mockResolvedValue(1);
    prismaMock.bloggerProfile.findMany.mockResolvedValue([
      {
        id: 'p_match',
        channelId: null,
        topics: ['финтех'],
        languages: [],
        formats: [],
        audience: {},
        rateCards: [],
        placementOffers: [],
        reach: null,
        avgViews: null,
        capturedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        postInsightRefreshStatus: 'idle',
        postInsightRefreshError: null,
        postInsightRefreshedAt: null,
        dataPoints: [],
        postInsights: [],
        _count: { dataPoints: 0 },
      },
    ]);
    prismaMock.matchResult.findMany.mockResolvedValue([
      {
        profileId: 'p_match',
        score: '0.77',
        rationale: 'persisted',
        rerankedByLlm: false,
        fitSignals: {
          positiveSignals: ['saved signal'],
          gaps: ['saved gap'],
          scoreBreakdown: { total: 0.77 },
        },
        evidencePostIds: ['post1'],
      },
    ]);

    const out = await bloggerProfilesService.list({ briefId: 'brief1' });
    expect((out.items[0] as { fit?: unknown }).fit).toMatchObject({
      score: 0.77,
      source: 'match_result',
      rationale: 'persisted',
      positiveSignals: ['saved signal'],
      gaps: ['saved gap'],
      evidencePostIds: ['post1'],
    });
  });

  it('rejects campaign context when the campaign goal is missing', async () => {
    prismaMock.campaign.findUnique.mockResolvedValue({
      id: 'camp1',
      goal: null,
      goalText: 'goal',
      valueProp: 'value',
      createdAt: NOW,
      type: { key: 'custdev' },
    });
    await expect(bloggerProfilesService.list({ campaignId: 'camp1' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('enqueues a channel scrape refresh and marks unsupported profiles explicitly', async () => {
    prismaMock.bloggerProfile.findUnique.mockResolvedValueOnce({ id: 'p1', channelId: 'ch1' });
    prismaMock.channel.findUnique.mockResolvedValueOnce({ id: 'ch1', platform: 'telegram' });
    const ok = await bloggerProfilesService.requestPostInsightRefresh('p1');
    expect(ok).toMatchObject({ postInsightRefreshStatus: 'pending' });
    expect(channelScrapeAdd).toHaveBeenCalledWith('refresh-post-insights', { channelId: 'ch1' });

    prismaMock.bloggerProfile.findUnique.mockResolvedValueOnce({ id: 'p2', channelId: null });
    const unsupported = await bloggerProfilesService.requestPostInsightRefresh('p2');
    expect(unsupported).toMatchObject({ postInsightRefreshStatus: 'unsupported' });
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

  it('surfaces structured placement offers and keeps day vs month post prices distinct', async () => {
    const dayPost = {
      kind: 'post',
      platform: 'telegram',
      price: 13000,
      currency: 'RUB',
      attributes: [{ key: 'duration', value: 'day', confidence: 0.9, rawSnippet: 'на сутки' }],
      confidence: 0.9,
      rawSnippet: 'пост на сутки 13000',
      sourceMessageId: 'm_offers',
      extractedBy: 'rate_card_extractor',
      capturedAt: NOW.toISOString(),
    };
    const monthPost = {
      kind: 'post',
      platform: 'telegram',
      price: 21000,
      currency: 'RUB',
      attributes: [
        { key: 'duration', value: 'month', confidence: 0.9, rawSnippet: 'на месяц' },
        { key: 'tax', value: 'налог 6%', confidence: 0.8, rawSnippet: '+ налог 6%' },
      ],
      confidence: 0.9,
      rawSnippet: 'пост на месяц 21000 + налог 6%',
      sourceMessageId: 'm_offers',
      extractedBy: 'rate_card_extractor',
      capturedAt: NOW.toISOString(),
    };
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_offers',
      channelId: null,
      topics: [],
      languages: ['ru'],
      formats: ['telegram_post_day', 'telegram_post_month'],
      audience: {},
      rateCards: [
        { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
        { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
      ],
      placementOffers: [dayPost, monthPost],
      reach: null,
      avgViews: null,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [],
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p_offers');

    // Structured offers surface with typed attributes and provenance.
    expect(out.placementOffers).toHaveLength(2);
    expect(out.placementOffers[1]).toMatchObject({
      kind: 'post',
      price: 21000,
      currency: 'RUB',
      sourceMessageId: 'm_offers',
      rawSnippet: 'пост на месяц 21000 + налог 6%',
    });
    // Day vs month post stay distinct compatibility rate cards (no collapse).
    expect(out.rateCards).toEqual([
      { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
    ]);
    expect(out.formats).toEqual(['telegram_post_day', 'telegram_post_month']);
  });

  it('keeps unknown / inactive attributes out of the active offer attributes (review-only)', async () => {
    // Section 2 persists only validated active attributes on the offer; an
    // unknown key (e.g. an unapproved proposal) is NOT stored as an offer
    // attribute, so it must not appear on the read surface.
    const offer = {
      kind: 'post',
      platform: 'telegram',
      price: 21000,
      currency: 'RUB',
      attributes: [{ key: 'duration', value: 'month', confidence: 0.9, rawSnippet: '' }],
      confidence: 0.9,
      rawSnippet: 'пост на месяц 21000',
      sourceMessageId: null,
      extractedBy: 'llm',
      capturedAt: NOW.toISOString(),
    };
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_review',
      channelId: null,
      topics: [],
      languages: ['ru'],
      formats: [],
      audience: {},
      rateCards: [],
      placementOffers: [offer],
      reach: null,
      avgViews: null,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [],
      mediaAssets: [],
    });

    const out = await bloggerProfilesService.get('p_review');
    const keys = out.placementOffers[0]?.attributes.map((a) => a.key) ?? [];
    expect(keys).toEqual(['duration']);
    // No unknown/inactive attribute leaked onto the active offer.
    expect(keys).not.toContain('delete_policy_v2');
    expect(JSON.stringify(out.placementOffers)).not.toContain('proposal');
  });

  it('repairs inline placement terms from source text so post prices do not collapse', async () => {
    const inlineQuote = `Добрый день) у нас есть формат размещений в тг-канале: пост на сутки 13000, пост на месяц 21000 + налог 6%

А также есть формат выездных обзоров в кидфрендли места: стоимость 30000 (входит пост обзор без удаления + доп пост с упоминанием важных событий и анонсов)`;
    prismaMock.bloggerProfile.findUnique.mockResolvedValue({
      id: 'p_inline',
      channelId: 'chan_inline',
      topics: [],
      languages: ['ru'],
      formats: ['post', 'other'],
      audience: {},
      rateCards: [
        { format: 'post', price: 13000, currency: 'RUB' },
        { format: 'other', price: 30000, currency: 'RUB' },
      ],
      reach: null,
      avgViews: null,
      capturedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      dataPoints: [
        {
          id: 'dp_inline',
          profileId: 'p_inline',
          field: 'rate.post',
          value: 13000,
          unit: 'RUB',
          confidence: '0.8',
          extractedBy: 'rate_card_extractor',
          sourceMessageId: 'm_inline',
          rawSnippet: 'пост на сутки 13000',
          capturedAt: NOW,
          createdAt: NOW,
        },
      ],
      mediaAssets: [],
    });
    prismaMock.message.findMany.mockResolvedValue([{ id: 'm_inline', text: inlineQuote }]);

    const out = await bloggerProfilesService.get('p_inline');

    expect(out.rateCards).toEqual([
      { format: 'offsite_review', price: 30000, currency: 'RUB' },
      { format: 'telegram_post_day', price: 13000, currency: 'RUB' },
      { format: 'telegram_post_month', price: 21000, currency: 'RUB' },
    ]);
    expect(out.formats).toEqual(['offsite_review', 'telegram_post_day', 'telegram_post_month']);
  });
});
