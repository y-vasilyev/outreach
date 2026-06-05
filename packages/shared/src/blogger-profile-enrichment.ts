import type {
  ProfileDataPointDraft,
  RateCard,
  SocialProfileLink,
} from './schemas/blogger-profile.js';

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

function canonicalFormat(label: string, platform: string | null): string {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const prefix = platform ? `${platform}_` : '';
  if (/фото\s*-?\s*пост|фотопост|photo\s*-?\s*post/.test(l)) return `${prefix}photo_post`;
  if (/видео\s*-?\s*пост|видеопост|video\s*-?\s*post/.test(l)) return `${prefix}video_post`;
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

    const m = /^(.+?)\s+[—–]\s+((?:\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:к|k)?)(?:\s*(₽|руб\.?|р\.?|rub|usd|\$|eur|€))?\s*$/i.exec(line);
    if (!m) continue;
    const label = m[1]!.trim();
    if (/налог|бонус|статистик|скидк/i.test(label)) continue;
    const price = parsePrice(m[2]!);
    if (price == null) continue;
    const format = canonicalFormat(label, platform);
    const key = `${format}:${price}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      field: `rate.${format}`,
      value: price,
      unit: parseCurrency(m[3]),
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
