import { getPrisma } from '@nosquare/db';
import {
  BloggerPostMetricsZ,
  buildFitBreakdown,
  buildBloggerProfilePresentation,
  computePostMetricFreshness,
  Errors,
  computeProfileFreshness,
  derivePlacementFormatKey,
  extractAgencyClientBrief,
  rankPostInsightsForPreview,
  scorePostPerformance,
  scoreProfile,
  extractRateCardDataPointsFromText,
  hasOnlyGenericRateCards,
  placementOffersToFormats,
  placementOffersToRateCards,
  PlacementOfferZ,
  rateCardsFromDataPoints,
  RateCardZ,
  CampaignAjtbdZ,
  type PlacementOffer,
  type RateCard,
  type AdBrief,
  type BloggerPostInsight,
  type CatalogFit,
  type MatchableProfile,
  type SocialProfileLink,
} from '@nosquare/shared';
import { getFeatureFlags } from '../feature-flags.js';
import { getQueues } from '../queues.js';

type ProfileDataPointSource = {
  sourceMessageId?: string | null;
  rawSnippet?: string | null;
};

type ChannelPresentationSource = {
  id: string;
  platform: string;
  handle: string;
  title: string | null;
  links: string[];
} | null;

type DbPostInsight = {
  id: string;
  profileId: string;
  channelId: string | null;
  platform: string;
  externalPostId: string;
  url: string | null;
  publishedAt: Date | null;
  textSnippet: string;
  mediaKind: string;
  metrics: unknown;
  metricCapturedAt: Date | null;
  source: string;
  sourceRawRef: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const channelSelect = {
  id: true,
  platform: true,
  handle: true,
  title: true,
  links: true,
} as const;

function parseRateCards(value: unknown): RateCard[] {
  const arr = Array.isArray(value) ? value : [];
  const out: RateCard[] = [];
  for (const item of arr) {
    const parsed = RateCardZ.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Parse the stored `BloggerProfile.placementOffers` Json column into validated
 * structured offers (entity-style-rate-cards). Invalid entries are dropped —
 * the column is rolled up by the worker from validated `placement.offer` data
 * points, so this is a defensive boundary parse.
 */
function parsePlacementOffers(value: unknown): PlacementOffer[] {
  const arr = Array.isArray(value) ? value : [];
  const out: PlacementOffer[] = [];
  for (const item of arr) {
    const parsed = PlacementOfferZ.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function serializePostInsight(
  row: DbPostInsight,
  opts: { avgViews?: number | null; refreshStatus?: string | null } = {},
): BloggerPostInsight {
  const metrics = BloggerPostMetricsZ.parse(row.metrics ?? {});
  const base = {
    id: row.id,
    profileId: row.profileId,
    channelId: row.channelId ?? null,
    platform: row.platform,
    externalPostId: row.externalPostId,
    url: row.url ?? null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    textSnippet: row.textSnippet,
    mediaKind: (['post', 'story', 'reels', 'shorts', 'video', 'other'].includes(row.mediaKind)
      ? row.mediaKind
      : 'other') as BloggerPostInsight['mediaKind'],
    metrics,
    metricCapturedAt: row.metricCapturedAt ? row.metricCapturedAt.toISOString() : null,
    source: (['scrapecreators', 'telegram_public_parse', 'manual_import'].includes(row.source)
      ? row.source
      : 'manual_import') as BloggerPostInsight['source'],
    sourceRawRef: row.sourceRawRef ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return {
    ...base,
    freshness: computePostMetricFreshness({
      metrics,
      metricCapturedAt: base.metricCapturedAt,
      refreshStatus: opts.refreshStatus,
    }),
    performanceScore: scorePostPerformance(base, { avgViews: opts.avgViews ?? null }),
  };
}

/**
 * Merge structured-offer-derived rate cards/formats with the legacy ones,
 * mirroring `rollUpProfileFields`: structured offers are the source of truth and
 * win over a legacy card mapping to the same derived format key, but distinct
 * legacy cards with no structured equivalent are preserved. Two distinct offers
 * (day vs month post) stay two cards.
 */
function mergeStructuredRates(
  offers: PlacementOffer[],
  legacy: { rateCards: RateCard[]; formats: string[] },
): { rateCards: RateCard[]; formats: string[] } {
  if (offers.length === 0) return legacy;
  const structuredRateCards = placementOffersToRateCards(offers);
  const structuredFormatKeys = new Set(offers.map((o) => derivePlacementFormatKey(o)));
  const rateCards: RateCard[] = [...structuredRateCards];
  for (const card of legacy.rateCards) {
    if (structuredFormatKeys.has(card.format)) continue;
    rateCards.push(card);
  }
  const formats: string[] = [];
  for (const f of placementOffersToFormats(offers)) {
    if (!formats.includes(f)) formats.push(f);
  }
  for (const f of legacy.formats) {
    if (!formats.includes(f)) formats.push(f);
  }
  for (const card of rateCards) {
    if (!formats.includes(card.format)) formats.push(card.format);
  }
  return { rateCards, formats };
}

function collectSourceMessageIds(dataPoints: ProfileDataPointSource[]): string[] {
  return [...new Set(dataPoints.map((dp) => dp.sourceMessageId).filter((id): id is string => !!id))];
}

function sourceTexts(
  dataPoints: ProfileDataPointSource[],
  messagesById: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const id of collectSourceMessageIds(dataPoints)) {
    const text = messagesById.get(id);
    if (text) out.push(text);
  }
  for (const dp of dataPoints) {
    if (dp.rawSnippet) out.push(dp.rawSnippet);
  }
  return out;
}

function fullMessageTexts(
  dataPoints: ProfileDataPointSource[],
  messagesById: Map<string, string>,
): string[] {
  return collectSourceMessageIds(dataPoints)
    .map((id) => messagesById.get(id))
    .filter((text): text is string => !!text);
}

function refinedRates(profile: { rateCards: unknown; formats: string[] }, texts: string[]) {
  const existing = parseRateCards(profile.rateCards);
  const parsedPoints = texts.flatMap((text) => extractRateCardDataPointsFromText(text));
  const parsedRateCards = rateCardsFromDataPoints(parsedPoints).sort((a, b) =>
    a.format.localeCompare(b.format),
  );
  const parsedHasPlatformContext = parsedRateCards.some((r) =>
    /^(telegram|youtube|instagram|vk|tiktok)_/.test(r.format),
  );
  const shouldReplace =
    parsedRateCards.length > 0 &&
    parsedHasPlatformContext &&
    (existing.length === 0 ||
      (parsedHasPlatformContext && hasOnlyGenericRateCards(existing)) ||
      parsedRateCards.length >= existing.length);

  if (!shouldReplace) {
    return { rateCards: existing, formats: profile.formats };
  }
  return {
    rateCards: parsedRateCards,
    formats: parsedRateCards.map((r) => r.format),
  };
}

function withPresentation<T extends {
  id: string;
  channelId: string | null;
  formats: string[];
  rateCards: unknown;
  placementOffers?: unknown;
  avgViews?: number | null;
  postInsightRefreshStatus?: string | null;
  postInsights?: DbPostInsight[];
}>(
  profile: T,
  opts: {
    channel: ChannelPresentationSource;
    dataPoints: ProfileDataPointSource[];
    messagesById: Map<string, string>;
  },
): T & {
  displayName: string | null;
  socialLinks: SocialProfileLink[];
  rateCards: RateCard[];
  formats: string[];
  placementOffers: PlacementOffer[];
  topPostsPreview: ReturnType<typeof rankPostInsightsForPreview>;
  postInsights?: BloggerPostInsight[];
} {
  const texts = sourceTexts(opts.dataPoints, opts.messagesById);
  const messageTexts = fullMessageTexts(opts.dataPoints, opts.messagesById);
  const presentation = buildBloggerProfilePresentation({
    profileId: profile.id,
    channelId: profile.channelId,
    channel: opts.channel,
    texts,
  });
  const legacyRates = refinedRates(profile, messageTexts);
  // Structured placement offers are the source of truth for commercial terms
  // when present (entity-style-rate-cards). They're rolled up onto the profile
  // column by the worker; the legacy text-repair path above stays as a fallback
  // for profiles that predate structured extraction.
  const placementOffers = parsePlacementOffers(profile.placementOffers);
  const rates = mergeStructuredRates(placementOffers, legacyRates);
  const serializedPosts = (profile.postInsights ?? []).map((p) =>
    serializePostInsight(p, {
      avgViews: profile.avgViews ?? null,
      refreshStatus: profile.postInsightRefreshStatus ?? null,
    }),
  );
  return {
    ...profile,
    displayName: presentation.displayName,
    socialLinks: presentation.socialLinks,
    rateCards: rates.rateCards,
    formats: rates.formats,
    placementOffers,
    postInsights: serializedPosts,
    topPostsPreview: rankPostInsightsForPreview(serializedPosts, {
      avgViews: profile.avgViews ?? null,
      limit: 3,
    }),
  };
}

function toBrief(row: {
  id: string;
  topic: string;
  audienceTarget: string;
  budget: number | null;
  formats: string[];
  geo: string[];
  deadline: Date | null;
  notes: string;
  createdAt: Date;
}): AdBrief {
  return {
    id: row.id,
    topic: row.topic,
    audienceTarget: row.audienceTarget,
    budget: row.budget ?? null,
    formats: row.formats,
    geo: row.geo,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMatchable(profile: {
  id: string;
  topics: string[];
  languages: string[];
  formats: string[];
  audience: unknown;
  rateCards: unknown;
  placementOffers?: unknown;
  reach: number | null;
  avgViews: number | null;
}): MatchableProfile {
  return {
    id: profile.id,
    topics: profile.topics,
    languages: profile.languages,
    formats: profile.formats,
    audience: profile.audience && typeof profile.audience === 'object' ? profile.audience as never : {},
    rateCards: parseRateCards(profile.rateCards),
    placementOffers: parsePlacementOffers(profile.placementOffers),
    reach: profile.reach,
    avgViews: profile.avgViews,
  };
}

async function briefFromCampaign(campaignId: string): Promise<AdBrief> {
  const prisma = getPrisma();
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      goal: true,
      goalText: true,
      valueProp: true,
      createdAt: true,
      type: { select: { key: true } },
    },
  });
  if (!c) throw Errors.notFound('campaign', campaignId);
  const typeKey = c.type?.key ?? null;
  if (c.goal == null) throw Errors.badRequest('campaign goal is required for catalog fit');
  if (typeKey === 'custdev') {
    const parsed = CampaignAjtbdZ.safeParse(c.goal);
    if (!parsed.success) throw Errors.badRequest('invalid custdev campaign goal');
    return {
      id: c.id,
      topic: parsed.data.job || c.goalText,
      audienceTarget: parsed.data.desired_outcome,
      budget: null,
      formats: [],
      geo: [],
      deadline: null,
      notes: [
        parsed.data.when,
        ...parsed.data.forces.push,
        ...parsed.data.forces.pull,
        ...parsed.data.non_goals.map((g) => `non-goal: ${g}`),
      ]
        .filter(Boolean)
        .join('\n'),
      createdAt: c.createdAt.toISOString(),
    };
  }
  if (typeKey === 'agency_sourcing') {
    if (!c.goal || typeof c.goal !== 'object') {
      throw Errors.badRequest('invalid agency_sourcing campaign goal');
    }
    const goal = c.goal as Record<string, unknown>;
    const targetPoints = Array.isArray(goal.target_data_points)
      ? goal.target_data_points.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      id: c.id,
      topic: extractAgencyClientBrief({ goal: c.goal, valueProp: c.valueProp }) || c.goalText,
      audienceTarget: String(goal.audience_target ?? goal.audience ?? ''),
      budget: typeof goal.budget === 'number' ? goal.budget : null,
      formats: Array.isArray(goal.formats)
        ? goal.formats.filter((x): x is string => typeof x === 'string')
        : [],
      geo: Array.isArray(goal.geo) ? goal.geo.filter((x): x is string => typeof x === 'string') : [],
      deadline: null,
      notes: targetPoints.length ? `target data points: ${targetPoints.join(', ')}` : c.valueProp,
      createdAt: c.createdAt.toISOString(),
    };
  }
  throw Errors.badRequest(`unsupported campaign type for catalog fit: ${typeKey ?? 'unknown'}`);
}

function fitFromMatchResult(row: {
  score: unknown;
  rationale: string;
  rerankedByLlm: boolean;
  fitSignals: unknown;
  evidencePostIds: string[];
}): CatalogFit {
  const signals = row.fitSignals && typeof row.fitSignals === 'object'
    ? row.fitSignals as { positiveSignals?: unknown; gaps?: unknown; scoreBreakdown?: unknown }
    : {};
  return {
    score: Number(row.score),
    source: row.rerankedByLlm ? 'llm_rerank' : 'match_result',
    rationale: row.rationale,
    positiveSignals: Array.isArray(signals.positiveSignals)
      ? signals.positiveSignals.filter((x): x is string => typeof x === 'string')
      : [],
    gaps: Array.isArray(signals.gaps)
      ? signals.gaps.filter((x): x is string => typeof x === 'string')
      : [],
    evidencePostIds: row.evidencePostIds,
    scoreBreakdown:
      signals.scoreBreakdown && typeof signals.scoreBreakdown === 'object'
        ? Object.fromEntries(
            Object.entries(signals.scoreBreakdown as Record<string, unknown>).filter(
              (kv): kv is [string, number] => typeof kv[1] === 'number',
            ),
          )
        : { total: Number(row.score) },
  };
}

/**
 * Blogger commercial profile read service (agency-sourcing-matching M5, task
 * 5.4). Read-only: profiles are written by the profile-extract worker. The
 * detail view returns the standardized rolled-up fields plus the contributing
 * `profile_data_point` rows (with provenance) so an operator can audit how the
 * profile was composed.
 *
 * Per-section freshness (`freshness` on the detail response) is derived
 * on read from the data points — see `blogger-profile-freshness` change.
 */
export const bloggerProfilesService = {
  async list(opts: { limit?: number; offset?: number; campaignId?: string; briefId?: string } = {}) {
    if (opts.campaignId && opts.briefId) {
      throw Errors.badRequest('campaignId and briefId are mutually exclusive');
    }
    const prisma = getPrisma();
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const brief = opts.campaignId
      ? await briefFromCampaign(opts.campaignId)
      : opts.briefId
        ? await prisma.adBrief.findUnique({ where: { id: opts.briefId } }).then((b) => {
            if (!b) throw Errors.notFound('ad_brief', opts.briefId);
            return toBrief(b);
          })
        : null;
    const [items, total] = await Promise.all([
      prisma.bloggerProfile.findMany({
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        include: {
          _count: { select: { dataPoints: true } },
          dataPoints: {
            select: { sourceMessageId: true, rawSnippet: true },
            orderBy: { capturedAt: 'desc' },
          },
          postInsights: {
            orderBy: [{ metricCapturedAt: 'desc' }, { publishedAt: 'desc' }],
            take: 20,
          },
        },
      }),
      prisma.bloggerProfile.count(),
    ]);
    const channelIds = [...new Set(items.map((p) => p.channelId).filter((id): id is string => !!id))];
    const sourceIds = [...new Set(items.flatMap((p) => collectSourceMessageIds(p.dataPoints)))];
    const [channels, messages] = await Promise.all([
      channelIds.length
        ? prisma.channel.findMany({ where: { id: { in: channelIds } }, select: channelSelect })
        : Promise.resolve([]),
      sourceIds.length
        ? prisma.message.findMany({ where: { id: { in: sourceIds } }, select: { id: true, text: true } })
        : Promise.resolve([]),
    ]);
    const channelById = new Map(channels.map((ch) => [ch.id, ch]));
    const messagesById = new Map(messages.map((m) => [m.id, m.text]));
    const persistedMatches = opts.briefId
      ? await prisma.matchResult.findMany({ where: { briefId: opts.briefId } })
      : [];
    const matchByProfile = new Map(persistedMatches.map((m) => [m.profileId, m]));
    const useStructuredOffers = getFeatureFlags().get('structured_placement_offers');
    return {
      items: items.map((p) => {
        const { dataPoints, ...profile } = p;
        const presented = withPresentation(profile, {
          channel: p.channelId ? channelById.get(p.channelId) ?? null : null,
          dataPoints,
          messagesById,
        });
        if (!brief) return presented;
        const match = matchByProfile.get(p.id);
        if (match) return { ...presented, fit: fitFromMatchResult(match) };
        const scored = scoreProfile(brief, toMatchable(p), { useStructuredOffers });
        return {
          ...presented,
          fit: buildFitBreakdown(brief, presented, scored, presented.postInsights ?? [], 'deterministic'),
        };
      }),
      total,
      limit: take,
      offset: skip,
    };
  },

  async get(id: string) {
    const prisma = getPrisma();
    const profile = await prisma.bloggerProfile.findUnique({
      where: { id },
      include: {
        dataPoints: { orderBy: [{ field: 'asc' }, { capturedAt: 'desc' }] },
        postInsights: {
          orderBy: [{ metricCapturedAt: 'desc' }, { publishedAt: 'desc' }],
        },
        // Surface the media kits / stat screenshots attached to this profile so
        // the detail view can offer a (presigned) download per asset. We expose
        // only safe metadata — never the s3Key or any credential.
        mediaAssets: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!profile) throw Errors.notFound('blogger_profile', id);
    const sourceIds = collectSourceMessageIds(profile.dataPoints);
    const [channel, messages] = await Promise.all([
      profile.channelId
        ? prisma.channel.findUnique({ where: { id: profile.channelId }, select: channelSelect })
        : Promise.resolve(null),
      sourceIds.length
        ? prisma.message.findMany({ where: { id: { in: sourceIds } }, select: { id: true, text: true } })
        : Promise.resolve([]),
    ]);
    const messagesById = new Map(messages.map((m) => [m.id, m.text]));
    const freshness = computeProfileFreshness(
      profile.dataPoints.map((dp) => ({
        field: dp.field,
        value: dp.value,
        capturedAt: dp.capturedAt,
      })),
    );
    const serialized = {
      ...profile,
      // Prisma serializes Decimal to a string over JSON; map confidence back to
      // a JS number at the API boundary so the frontend gets a real number.
      dataPoints: profile.dataPoints.map((dp) => ({
        ...dp,
        confidence: Number(dp.confidence),
      })),
      mediaAssets: profile.mediaAssets.map((a) => ({
        id: a.id,
        kind: a.kind,
        mime: a.mime,
        bytes: a.bytes,
        ocrStatus: a.ocrStatus,
        createdAt: a.createdAt,
      })),
      postInsights: profile.postInsights,
      freshness,
    };
    return withPresentation(serialized, {
      channel,
      dataPoints: serialized.dataPoints,
      messagesById,
    });
  },

  async requestPostInsightRefresh(id: string) {
    const prisma = getPrisma();
    const profile = await prisma.bloggerProfile.findUnique({
      where: { id },
      select: { id: true, channelId: true },
    });
    if (!profile) throw Errors.notFound('blogger_profile', id);
    if (!profile.channelId) {
      return prisma.bloggerProfile.update({
        where: { id },
        data: {
          postInsightRefreshStatus: 'unsupported',
          postInsightRefreshError: 'profile has no linked channel',
        },
        select: { id: true, postInsightRefreshStatus: true, postInsightRefreshError: true },
      });
    }
    const channel = await prisma.channel.findUnique({
      where: { id: profile.channelId },
      select: { id: true, platform: true },
    });
    if (!channel || !['telegram', 'instagram', 'youtube'].includes(channel.platform)) {
      return prisma.bloggerProfile.update({
        where: { id },
        data: {
          postInsightRefreshStatus: 'unsupported',
          postInsightRefreshError: 'profile source is not supported for post insight refresh',
        },
        select: { id: true, postInsightRefreshStatus: true, postInsightRefreshError: true },
      });
    }
    await prisma.bloggerProfile.update({
      where: { id },
      data: { postInsightRefreshStatus: 'pending', postInsightRefreshError: null },
    });
    await getQueues().channelScrape.add('refresh-post-insights', { channelId: channel.id });
    return { id, postInsightRefreshStatus: 'pending', postInsightRefreshError: null };
  },
};
