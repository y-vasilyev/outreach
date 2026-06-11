import type { BloggerProfile } from './types';

/**
 * Human title for a blogger profile that NEVER leaks an internal CUID
 * (decision-ux): the server's displayName falls back to channelId/profileId
 * when neither a channel title nor a handle is known — that fallback is an
 * audit identifier, not a name.
 */
export function bloggerDisplayTitle(p: BloggerProfile): string {
  const name = p.displayName?.trim();
  if (name && name !== p.channelId && name !== p.id && name !== p.id.slice(0, 8)) return name;
  if (p.channel?.title) return p.channel.title;
  if (p.channel?.handle) return `@${p.channel.handle}`;
  return 'Без названия';
}

export interface BloggerPlatformLink {
  platform: string;
  url: string | null;
  handle: string | null;
  /** The linked channel's platform — the profile's primary surface. */
  primary: boolean;
}

/**
 * Union of every platform the blogger is present on: social links, known
 * per-platform audiences, and offer platforms (a multi-platform blogger is
 * never reduced to the linked channel).
 */
export function bloggerPlatformLinks(p: BloggerProfile): BloggerPlatformLink[] {
  const byPlatform = new Map<string, { url: string | null; handle: string | null }>();
  const add = (platform: string | null | undefined, url?: string | null, handle?: string | null) => {
    const key = (platform ?? '').trim().toLowerCase();
    if (!key) return;
    const existing = byPlatform.get(key);
    if (!existing) {
      byPlatform.set(key, { url: url ?? null, handle: handle ?? null });
      return;
    }
    // First URL/handle wins; later mentions only fill gaps.
    if (!existing.url && url) existing.url = url;
    if (!existing.handle && handle) existing.handle = handle;
  };

  if (p.channel) add(p.channel.platform, p.channel.url, p.channel.handle);
  for (const link of p.socialLinks ?? []) add(link.platform, link.url, link.handle ?? null);
  for (const pa of p.platformAudience ?? []) add(pa.platform);
  for (const o of p.placementOffers ?? []) add(o.platform);

  const primary = p.channel?.platform?.toLowerCase() ?? null;
  return [...byPlatform.entries()]
    .map(([platform, v]) => ({ platform, ...v, primary: platform === primary }))
    .sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      return a.platform.localeCompare(b.platform);
    });
}
