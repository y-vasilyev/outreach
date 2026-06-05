import { getPrisma } from '@nosquare/db';
import {
  buildBloggerProfilePresentation,
  computeProfileFreshness,
  derivePlacementFormatKey,
  Errors,
  extractRateCardDataPointsFromText,
  hasOnlyGenericRateCards,
  placementOffersToFormats,
  placementOffersToRateCards,
  PlacementOfferZ,
  rateCardsFromDataPoints,
  RateCardZ,
  type PlacementOffer,
  type RateCard,
  type SocialProfileLink,
} from '@nosquare/shared';

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
  return {
    ...profile,
    displayName: presentation.displayName,
    socialLinks: presentation.socialLinks,
    rateCards: rates.rateCards,
    formats: rates.formats,
    placementOffers,
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
  async list(opts: { limit?: number; offset?: number } = {}) {
    const prisma = getPrisma();
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
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
    return {
      items: items.map((p) => {
        const { dataPoints, ...profile } = p;
        return withPresentation(profile, {
          channel: p.channelId ? channelById.get(p.channelId) ?? null : null,
          dataPoints,
          messagesById,
        });
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
        createdAt: a.createdAt,
      })),
      freshness,
    };
    return withPresentation(serialized, {
      channel,
      dataPoints: serialized.dataPoints,
      messagesById,
    });
  },
};
