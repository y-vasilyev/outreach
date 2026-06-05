import type { Platform } from '../types.js';

/**
 * Yandex Search has to be asked for pages on the supported social hosts.
 * A plain niche query ("финтех блогеры") often returns articles/catalogs,
 * which are then correctly dropped by `extractCandidates` because they are
 * not direct channel/profile URLs.
 */
const PLATFORM_SITE_SCOPES: Record<Platform, readonly string[]> = {
  telegram: ['site:t.me'],
  instagram: ['site:instagram.com'],
  youtube: ['site:youtube.com'],
};

const PLATFORM_ORDER: readonly Platform[] = ['telegram', 'instagram', 'youtube'];

export function buildDiscoverySearchQueries(
  query: string,
  opts: { platform?: Platform } = {},
): string[] {
  const q = normalizeQuery(query);
  if (!q) return [];

  const platforms = opts.platform ? [opts.platform] : PLATFORM_ORDER;
  const out = new Set<string>();
  for (const platform of platforms) {
    for (const scope of PLATFORM_SITE_SCOPES[platform]) {
      out.add(`${scope} ${q}`);
    }
  }
  return [...out];
}

function normalizeQuery(query: string): string {
  return (query ?? '').trim().replace(/\s+/g, ' ');
}
