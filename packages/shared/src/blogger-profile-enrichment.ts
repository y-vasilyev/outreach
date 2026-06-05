import type {
  ProfileDataPointDraft,
  RateCard,
  SocialProfileLink,
} from './schemas/blogger-profile.js';
import type {
  PlacementAttribute,
  PlacementOfferDraft,
} from './schemas/placement-offer.js';

export interface BloggerProfileSourceChannel {
  platform?: string | null;
  handle?: string | null;
  title?: string | null;
  links?: string[] | null;
}

export interface BloggerProfilePresentation {
  displayName: string | null;
  socialLinks: SocialProfileLink[];
}

const SOCIAL_HOSTS = [
  't.me',
  'telegram.me',
  'youtube.com',
  'youtu.be',
  'instagram.com',
  'vk.com',
  'tiktok.com',
] as const;

const GENERIC_RATE_FORMATS = new Set([
  'integration',
  'other',
  'post',
  'reels',
  'shorts',
  'story',
  'video',
]);

function cleanUrlToken(raw: string): string {
  return raw
    .trim()
    .replace(/[),.;!?]+$/g, '')
    .replace(/^http:\/\//i, 'https://');
}

function withScheme(raw: string): string {
  const clean = cleanUrlToken(raw);
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
}

function socialPlatformFromHost(hostname: string): string | null {
  const host = hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 't.me' || host === 'telegram.me') return 'telegram';
  if (host === 'youtube.com' || host === 'youtu.be') return 'youtube';
  if (host === 'instagram.com') return 'instagram';
  if (host === 'vk.com') return 'vk';
  if (host === 'tiktok.com') return 'tiktok';
  return null;
}

function canonicalSocialUrl(raw: string): SocialProfileLink | null {
  try {
    const url = new URL(withScheme(raw));
    const platform = socialPlatformFromHost(url.hostname);
    if (!platform) return null;
    const firstPathPart = url.pathname.split('/').filter(Boolean)[0] ?? '';
    if (!firstPathPart) return null;
    const handle = firstPathPart.replace(/^@/, '');
    if (!handle) return null;
    url.protocol = 'https:';
    url.hash = '';
    url.search = '';
    if (url.hostname.toLowerCase().startsWith('www.')) {
      url.hostname = url.hostname.replace(/^www\./i, '');
    }
    return { platform, url: url.toString().replace(/\/$/, ''), handle };
  } catch {
    return null;
  }
}

function channelProfileUrl(channel: BloggerProfileSourceChannel): SocialProfileLink | null {
  const platform = (channel.platform ?? '').toLowerCase();
  const handle = (channel.handle ?? '').trim().replace(/^@/, '');
  if (!platform || !handle) return null;
  if (platform === 'telegram') return canonicalSocialUrl(`https://t.me/${handle}`);
  if (platform === 'instagram') return canonicalSocialUrl(`https://instagram.com/${handle}`);
  if (platform === 'youtube') {
    const path = handle.startsWith('@') ? handle : `@${handle}`;
    return canonicalSocialUrl(`https://youtube.com/${path}`);
  }
  return null;
}

export function extractSocialProfileLinks(
  texts: string[],
  channel?: BloggerProfileSourceChannel | null,
): SocialProfileLink[] {
  const out: SocialProfileLink[] = [];
  const push = (link: SocialProfileLink | null) => {
    if (!link) return;
    if (out.some((x) => x.platform === link.platform && x.url === link.url)) return;
    out.push(link);
  };

  if (channel) {
    push(channelProfileUrl(channel));
    for (const link of channel.links ?? []) push(canonicalSocialUrl(link));
  }

  const urlRe = new RegExp(
    String.raw`(?:https?:\/\/)?(?:www\.)?(?:${SOCIAL_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})\/[^\s<>"']+`,
    'gi',
  );
  for (const text of texts) {
    for (const m of text.matchAll(urlRe)) push(canonicalSocialUrl(m[0] ?? ''));
  }
  return out;
}

export function buildBloggerProfilePresentation(opts: {
  profileId: string;
  channelId?: string | null;
  channel?: BloggerProfileSourceChannel | null;
  texts?: string[];
}): BloggerProfilePresentation {
  const socialLinks = extractSocialProfileLinks(opts.texts ?? [], opts.channel);
  const title = opts.channel?.title?.trim();
  if (title) return { displayName: title, socialLinks };

  const handleCounts = new Map<string, number>();
  for (const link of socialLinks) {
    if (!link.handle) continue;
    if (/^club\d+$/i.test(link.handle)) continue;
    handleCounts.set(link.handle, (handleCounts.get(link.handle) ?? 0) + 1);
  }
  const bestHandle = [...handleCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (bestHandle) return { displayName: `@${bestHandle}`, socialLinks };

  const channelHandle = opts.channel?.handle?.trim().replace(/^@/, '');
  if (channelHandle) return { displayName: `@${channelHandle}`, socialLinks };

  return { displayName: opts.channelId ?? opts.profileId.slice(0, 8), socialLinks };
}

function parseCurrency(raw: string | undefined): string {
  const c = (raw ?? '').trim().toLowerCase();
  if (c === '$' || c === 'usd') return 'USD';
  if (c === '€' || c === 'eur') return 'EUR';
  return 'RUB';
}

function parsePrice(raw: string): number | null {
  const normalized = raw
    .replace(/\u00a0/g, ' ')
    .replace(/\s/g, '')
    .replace(',', '.')
    .toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(к|k)?$/.exec(normalized);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? 1000 : 1));
}

function platformFromHeader(line: string): string | null {
  const m = /^\s*(telegram|телеграм|youtube|ютуб|instagram|инстаграм|вконтакте|vk|вк|tiktok|tik\s*tok|тик\s*ток)\s+[—–-]\s+/i.exec(line);
  if (!m) return null;
  const raw = m[1]!.toLowerCase().replace(/\s+/g, '');
  if (raw === 'telegram' || raw === 'телеграм') return 'telegram';
  if (raw === 'youtube' || raw === 'ютуб') return 'youtube';
  if (raw === 'instagram' || raw === 'инстаграм') return 'instagram';
  if (raw === 'вконтакте' || raw === 'vk' || raw === 'вк') return 'vk';
  if (raw === 'tiktok' || raw === 'тикток') return 'tiktok';
  return null;
}

function platformFromInlineText(line: string): string | null {
  if (/(^|[^\p{L}\p{N}])(?:тг|telegram|телеграм)(?=$|[^\p{L}\p{N}])/iu.test(line)) return 'telegram';
  if (/(^|[^\p{L}\p{N}])(?:youtube|ютуб)(?=$|[^\p{L}\p{N}])/iu.test(line)) return 'youtube';
  if (/(^|[^\p{L}\p{N}])(?:instagram|инстаграм)(?=$|[^\p{L}\p{N}])/iu.test(line)) return 'instagram';
  if (/(^|[^\p{L}\p{N}])(?:vk|вк|вконтакте)(?=$|[^\p{L}\p{N}])/iu.test(line)) return 'vk';
  if (/(^|[^\p{L}\p{N}])(?:tiktok|tik\s*tok|тик\s*ток)(?=$|[^\p{L}\p{N}])/iu.test(line)) return 'tiktok';
  return null;
}

function canonicalFormat(label: string, platform: string | null): string {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const prefix = platform ? `${platform}_` : '';
  if (/выездн[\p{L}\p{N}_]*\s+обзор|обзор[\p{L}\p{N}_]*\s+выездн/u.test(l)) return `${prefix}offsite_review`;
  if (/фото\s*-?\s*пост|фотопост|photo\s*-?\s*post/.test(l)) return `${prefix}photo_post`;
  if (/видео\s*-?\s*пост|видеопост|video\s*-?\s*post/.test(l)) return `${prefix}video_post`;
  if (/пост\s+на\s+(?:сутки|24\s*час(?:а|ов)?|день)/.test(l)) return `${prefix}post_day`;
  if (/пост\s+на\s+месяц/.test(l)) return `${prefix}post_month`;
  if (/кружок/.test(l)) return `${prefix}round_text`;
  if (/интеграц/.test(l)) {
    return /перв(ый|ого)?\s+слот|first\s+slot/.test(l) ? `${prefix}integration_first_slot` : `${prefix}integration`;
  }
  if (/shorts?|шортс?/.test(l)) return `${prefix}shorts`;
  if (/серия\s+сторис|сторис\s+серия|stories\s+series/.test(l)) return `${prefix}story_series`;
  if (/сторис|stories|story/.test(l)) return `${prefix}story`;
  if (/рилс|reels?/.test(l)) return `${prefix}reels`;
  if (/вк\s*-?\s*клип|клип|clips?/.test(l)) return `${prefix}clip`;
  if (/пост|post/.test(l)) return `${prefix}post`;
  if (/видео|video/.test(l)) return `${prefix}video`;
  return platform ? `${prefix}other` : 'other';
}

const PRICE_WITH_CURRENCY_RE_SOURCE = String.raw`((?:\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:к|k)?)(?:\s*(₽|руб\.?|р\.?|rub|usd|\$|eur|€))?`;

function cleanRawSnippet(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function pushRateDataPoint(
  out: ProfileDataPointDraft[],
  seen: Set<string>,
  opts: {
    format: string;
    price: number;
    currency?: string;
    confidence: number;
    rawSnippet: string;
  },
): void {
  const key = `${opts.format}:${opts.price}:${opts.rawSnippet}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    field: `rate.${opts.format}`,
    value: opts.price,
    unit: opts.currency ?? 'RUB',
    confidence: opts.confidence,
    rawSnippet: opts.rawSnippet,
  });
}

function extractInlineRateDataPointsFromLine(
  line: string,
  platform: string | null,
  out: ProfileDataPointDraft[],
  seen: Set<string>,
): void {
  const postDurationRe = new RegExp(
    String.raw`(^|[^\p{L}\p{N}])((?:пост|post)\s+на\s+(сутки|24\s*час(?:а|ов)?|день|месяц))\s*[:—–-]?\s*${PRICE_WITH_CURRENCY_RE_SOURCE}`,
    'giu',
  );
  for (const m of line.matchAll(postDurationRe)) {
    const rawSnippet = cleanRawSnippet(m[0] ?? '');
    const price = parsePrice(m[4] ?? '');
    if (!rawSnippet || price == null) continue;
    const period = /месяц/i.test(m[3] ?? '') ? 'month' : 'day';
    pushRateDataPoint(out, seen, {
      format: `${platform ? `${platform}_` : ''}post_${period}`,
      price,
      currency: parseCurrency(m[5]),
      confidence: 0.96,
      rawSnippet,
    });
  }

  if (!/выездн[\p{L}\p{N}_]*.{0,120}обзор|обзор[\p{L}\p{N}_]*.{0,120}выездн/iu.test(line)) return;
  const priceRe = new RegExp(
    String.raw`(?:стоимост[\p{L}\p{N}_]*|цена|стоит)\s*[:—–-]?\s*${PRICE_WITH_CURRENCY_RE_SOURCE}`,
    'iu',
  );
  const m = priceRe.exec(line);
  if (!m) return;
  const price = parsePrice(m[1] ?? '');
  if (price == null) return;
  const startCandidates = [
    line.search(/формат\s+выездн/iu),
    line.search(/выездн/iu),
    0,
  ].filter((idx) => idx >= 0);
  const start = Math.min(...startCandidates);
  const rawSnippet = line.slice(start, m.index + m[0].length).trim();
  pushRateDataPoint(out, seen, {
    format: 'offsite_review',
    price,
    currency: parseCurrency(m[2]),
    confidence: 0.92,
    rawSnippet,
  });
}

export function extractRateCardDataPointsFromText(text: string): ProfileDataPointDraft[] {
  const out: ProfileDataPointDraft[] = [];
  let platform: string | null = null;
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const nextPlatform = platformFromHeader(line);
    if (nextPlatform) {
      platform = nextPlatform;
      continue;
    }
    const linePlatform = platformFromInlineText(line) ?? platform;
    extractInlineRateDataPointsFromLine(line, linePlatform, out, seen);

    const m = /^(.+?)\s+[—–]\s+((?:\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:к|k)?)(?:\s*(₽|руб\.?|р\.?|rub|usd|\$|eur|€))?\s*$/i.exec(line);
    if (!m) continue;
    const label = m[1]!.trim();
    if (/налог|бонус|статистик|скидк/i.test(label)) continue;
    const price = parsePrice(m[2]!);
    if (price == null) continue;
    const format = canonicalFormat(label, linePlatform);
    pushRateDataPoint(out, seen, {
      format,
      price,
      currency: parseCurrency(m[3]),
      confidence: GENERIC_RATE_FORMATS.has(format) ? 0.75 : 0.96,
      rawSnippet: line,
    });
  }

  return out;
}

export function rateCardsFromDataPoints(points: ProfileDataPointDraft[]): RateCard[] {
  const cards: RateCard[] = [];
  for (const p of points) {
    const fmt = /^rate\.(.+)$/.exec(p.field)?.[1];
    if (!fmt || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
    cards.push({ format: fmt, price: p.value, currency: p.unit?.trim() || 'RUB' });
  }
  return cards;
}

export function hasOnlyGenericRateCards(rateCards: RateCard[]): boolean {
  return rateCards.length > 0 && rateCards.every((r) => GENERIC_RATE_FORMATS.has(r.format));
}

// ---------------------------------------------------------------------------
// Deterministic placement-offer builders (entity-style-rate-cards).
//
// These mirror the legacy `extractRateCardDataPointsFromText` parsing but emit
// structured `PlacementOfferDraft`s instead of `rate.<format>` data points. A
// placement is a commercial object: stable `kind` (post/story/reels/…), a
// promoted `platform`/`price`/`currency`, and typed `attributes`
// (`duration`, `delete_policy`, `includes`, `tax`, `notes`). Tax is ALWAYS an
// attribute on the priced offer, never a separate offer/price row.
//
// Pure, IO-free; reuses the private parse helpers above (parsePrice,
// parseCurrency, platformFromHeader/InlineText, canonicalFormat).
// ---------------------------------------------------------------------------

/**
 * Map a canonical legacy format key (e.g. `telegram_post_month`,
 * `offsite_review`, `youtube_integration_first_slot`, `vk_clip`) to a stable
 * placement `kind` from `KNOWN_PLACEMENT_KINDS`. Platform prefix + duration
 * suffix are stripped (they live on the offer's `platform`/`duration` instead).
 */
function kindFromFormat(format: string): string {
  // Strip a leading platform prefix if present.
  let f = format;
  const platformPrefix = /^(telegram|youtube|instagram|vk|tiktok)_/.exec(f);
  if (platformPrefix) f = f.slice(platformPrefix[0].length);
  // Strip a trailing duration suffix (post_day / post_month / post_week).
  f = f.replace(/_(day|week|month)$/, '');
  if (f === 'offsite_review') return 'offsite_review';
  if (f.startsWith('integration')) return 'integration';
  if (f.startsWith('story')) return 'story';
  if (f === 'reels') return 'reels';
  if (f === 'shorts') return 'shorts';
  if (f === 'clip') return 'reels';
  if (f === 'round_text') return 'post';
  if (f.endsWith('photo_post') || f.endsWith('video_post') || f === 'post') return 'post';
  if (f === 'video') return 'video';
  return 'other';
}

/** Detect a duration enum value (day/week/month/permanent) from free text. */
function durationFromText(text: string): 'day' | 'week' | 'month' | 'permanent' | null {
  const l = text.toLowerCase();
  if (/бессрочно|навсегда|без\s+удал|permanent|закреп/u.test(l)) {
    // "без удаления" is delete_policy, but "навсегда/бессрочно" also implies
    // a permanent lifetime. We only return permanent for explicit lifetime
    // phrasing; "без удаления" alone is handled by delete_policy.
    if (/бессрочно|навсегда|permanent/u.test(l)) return 'permanent';
  }
  if (/на\s+месяц|1\s*месяц|месяц/u.test(l)) return 'month';
  if (/на\s+недел|недел|week/u.test(l)) return 'week';
  if (/на\s+сутки|сутки|24\s*час|на\s+день|\bдень\b|day/u.test(l)) return 'day';
  return null;
}

/** Detect delete_policy (deleted/permanent) from free text. */
function deletePolicyFromText(text: string): 'deleted' | 'permanent' | null {
  const l = text.toLowerCase();
  if (/без\s+удал|не\s+удал|бессрочно|навсегда|остаётся|остается|permanent/u.test(l)) {
    return 'permanent';
  }
  if (/с\s+удал|удал[яе]|удаляется|deleted/u.test(l)) return 'deleted';
  return null;
}

/** Extract a `tax` note (e.g. "налог 6%", "+ налог на ИП") from free text. */
function taxFromText(text: string): string | null {
  const m = /(?:\+\s*)?налог[\p{L}\s]*(?:\d+\s*%|\bна\s+ип\b|включ[\p{L}]*)?[^.,;\n]*/iu.exec(text);
  if (!m) return null;
  const note = m[0].trim().replace(/^\+\s*/, '');
  return note.length > 0 ? note : null;
}

/** Extract included deliverables from "входит ..." / "+ доп пост" phrasing. */
function includesFromText(text: string): string[] {
  const out: string[] = [];
  // "(входит ... )" — capture the contents up to the closing paren / end.
  const inc = /входит[:\s]+([^).]+)/iu.exec(text);
  if (inc?.[1]) {
    for (const part of inc[1].split(/\+|,|;|\bи\b/iu)) {
      const p = part.trim().replace(/[).]+$/, '').trim();
      if (p.length > 2) out.push(p);
    }
  }
  // Standalone "+ доп пост" style additions outside an "входит" block.
  if (out.length === 0) {
    for (const m of text.matchAll(/\+\s*(доп[\p{L}\s]*пост[\p{L}\s]*|анонс[\p{L}\s]*|упоминани[\p{L}\s]*)/giu)) {
      const p = (m[1] ?? '').trim().replace(/[).]+$/, '').trim();
      if (p.length > 2) out.push(p);
    }
  }
  return out;
}

function makeAttr(
  key: string,
  value: PlacementAttribute['value'],
  rawSnippet: string,
  confidence = 0.9,
): PlacementAttribute {
  return { key, value, confidence, rawSnippet };
}

interface OfferAccumulator {
  offers: PlacementOfferDraft[];
  seen: Set<string>;
}

function pushOffer(acc: OfferAccumulator, offer: PlacementOfferDraft): void {
  const duration = offer.attributes.find((a) => a.key === 'duration')?.value ?? '';
  const key = `${offer.platform ?? ''}:${offer.kind}:${String(duration)}:${
    offer.price ?? ''
  }:${offer.rawSnippet.trim().toLowerCase()}`;
  if (acc.seen.has(key)) return;
  acc.seen.add(key);
  acc.offers.push(offer);
}

/**
 * Build placement offers from inline quote text (one or more lines mixing
 * platform mentions, post durations, and offsite reviews) — e.g.
 *   "пост на сутки 13000, пост на месяц 21000 + налог 6%"
 *   "выездной обзор: 30000 (входит пост обзор без удаления + доп пост)"
 *
 * Day vs month posts stay SEPARATE offers (distinct `duration`). Tax becomes a
 * `tax` attribute on every offer in the same line, never its own offer.
 */
function extractInlineOffersFromLine(
  line: string,
  platform: string | null,
  acc: OfferAccumulator,
): void {
  const tax = taxFromText(line);
  const taxSnippet = tax ?? '';
  const lineDeletePolicy = deletePolicyFromText(line);
  const lineIncludes = includesFromText(line);

  // Inline "пост на сутки/месяц <price>" — one offer per duration.
  const postDurationRe = new RegExp(
    String.raw`(^|[^\p{L}\p{N}])((?:пост|post)\s+на\s+(сутки|24\s*час(?:а|ов)?|день|месяц|недел[\p{L}]*))\s*[:—–-]?\s*${PRICE_WITH_CURRENCY_RE_SOURCE}`,
    'giu',
  );
  for (const m of line.matchAll(postDurationRe)) {
    const rawSnippet = cleanRawSnippet(m[0] ?? '');
    const price = parsePrice(m[4] ?? '');
    if (!rawSnippet || price == null) continue;
    const period = durationFromText(m[3] ?? '') ?? 'day';
    const attributes: PlacementAttribute[] = [makeAttr('duration', period, rawSnippet, 0.95)];
    if (lineDeletePolicy) attributes.push(makeAttr('delete_policy', lineDeletePolicy, line, 0.9));
    if (lineIncludes.length > 0) attributes.push(makeAttr('includes', lineIncludes, line, 0.85));
    if (tax) attributes.push(makeAttr('tax', tax, taxSnippet, 0.9));
    pushOffer(acc, {
      kind: 'post',
      platform,
      price,
      currency: parseCurrency(m[5]),
      attributes,
      confidence: 0.96,
      rawSnippet,
    });
  }

  // Offsite review ("выездной обзор ... стоимость <price>").
  if (/выездн[\p{L}\p{N}_]*.{0,160}обзор|обзор[\p{L}\p{N}_]*.{0,160}выездн/iu.test(line)) {
    const priceRe = new RegExp(
      String.raw`(?:стоимост[\p{L}\p{N}_]*|цена|стоит)\s*[:—–-]?\s*${PRICE_WITH_CURRENCY_RE_SOURCE}`,
      'iu',
    );
    const m = priceRe.exec(line);
    if (m) {
      const price = parsePrice(m[1] ?? '');
      if (price != null) {
        const startCandidates = [
          line.search(/формат\s+выездн/iu),
          line.search(/выездн/iu),
          0,
        ].filter((idx) => idx >= 0);
        const start = Math.min(...startCandidates);
        const rawSnippet = line.slice(start, m.index + m[0].length).trim();
        const attributes: PlacementAttribute[] = [];
        const dp = deletePolicyFromText(line);
        if (dp) attributes.push(makeAttr('delete_policy', dp, line, 0.9));
        if (lineIncludes.length > 0) {
          attributes.push(makeAttr('includes', lineIncludes, line, 0.85));
        }
        if (tax) attributes.push(makeAttr('tax', tax, taxSnippet, 0.9));
        pushOffer(acc, {
          kind: 'offsite_review',
          platform: null,
          price,
          currency: parseCurrency(m[2]),
          attributes,
          confidence: 0.92,
          rawSnippet,
        });
      }
    }
  }
}

/**
 * Build placement offers from a structured media-kit table (platform headers +
 * "<format> — <price>" rows), reusing `canonicalFormat`/`platformFromHeader`.
 */
function extractTableOffersFromLine(
  line: string,
  platform: string | null,
  acc: OfferAccumulator,
): void {
  const m = /^(.+?)\s+[—–]\s+((?:\d{1,3}(?:[\s ]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:к|k)?)(?:\s*(₽|руб\.?|р\.?|rub|usd|\$|eur|€))?\s*$/i.exec(
    line,
  );
  if (!m) return;
  const label = m[1]!.trim();
  // A tax / bonus / stats header is NOT a priced placement — skip as an offer
  // (tax is carried as an attribute on real offers by the caller).
  if (/налог|бонус|статистик|скидк/i.test(label)) return;
  const price = parsePrice(m[2]!);
  if (price == null) return;
  const format = canonicalFormat(label, platform);
  const kind = kindFromFormat(format);
  const attributes: PlacementAttribute[] = [];
  const duration = durationFromText(label);
  if (duration && kind === 'post') attributes.push(makeAttr('duration', duration, line, 0.9));
  const dp = deletePolicyFromText(label);
  if (dp) attributes.push(makeAttr('delete_policy', dp, line, 0.85));
  const includes = includesFromText(label);
  if (includes.length > 0) attributes.push(makeAttr('includes', includes, line, 0.8));
  // Preserve the original label as a note when it carried extra qualifiers
  // (e.g. "первый слот", "60-120 секунд") not otherwise captured.
  if (/первый\s+слот|first\s+slot|\d+\s*-?\s*\d*\s*секунд/iu.test(label)) {
    attributes.push(makeAttr('notes', label, line, 0.8));
  }
  pushOffer(acc, {
    kind,
    platform,
    price,
    currency: parseCurrency(m[3]),
    attributes,
    confidence: GENERIC_RATE_FORMATS.has(format.replace(/^(telegram|youtube|instagram|vk|tiktok)_/, ''))
      ? 0.78
      : 0.95,
    rawSnippet: line,
  });
}

/**
 * Deterministic placement-offer extractor over free-text blogger quotes.
 * Handles BOTH structured media-kit tables (platform headers + rows) and inline
 * sentence quotes (post durations, offsite reviews). Tax is an attribute, never
 * a separate offer. Ambiguous lines are never dropped silently — anything with
 * a price becomes an offer (kind `other`/`package` at low confidence when the
 * format is unclear).
 *
 * Returns drafts only — the worker stamps provenance on persist.
 * Reused by Section 5 matching if it needs structured terms from raw text.
 */
export function extractPlacementOffersFromText(text: string): PlacementOfferDraft[] {
  const acc: OfferAccumulator = { offers: [], seen: new Set<string>() };
  let platform: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const nextPlatform = platformFromHeader(line);
    if (nextPlatform) {
      platform = nextPlatform;
      continue;
    }
    const linePlatform = platformFromInlineText(line) ?? platform;
    extractInlineOffersFromLine(line, linePlatform, acc);
    extractTableOffersFromLine(line, linePlatform, acc);
  }

  return acc.offers;
}
