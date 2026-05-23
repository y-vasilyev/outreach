import type { Platform } from '../types.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { InstagramAdapter } from '../adapters/instagram.js';
import { YoutubeAdapter } from '../adapters/youtube.js';
import type { YandexSearchResult } from './YandexSearchClient.js';

/**
 * A discovered channel candidate — a search result that normalized to a known
 * platform handle (channel-discovery-search change).
 */
export interface DiscoveredCandidate {
  platform: Platform;
  handle: string;
  /** The source result URL the handle was parsed from. */
  url: string;
  title: string;
}

// parseHandle is pure (no scrape deps) — construct adapters directly so this
// stays usable without the global registry / scrape clients.
const ADAPTERS: ReadonlyArray<{ platform: Platform; parse: (s: string) => { handle: string } | null }> = [
  { platform: 'telegram', parse: (s) => new TelegramAdapter().parseHandle(s) },
  { platform: 'instagram', parse: (s) => new InstagramAdapter().parseHandle(s) },
  { platform: 'youtube', parse: (s) => new YoutubeAdapter().parseHandle(s) },
];

/**
 * First path segments that look like a handle to `parseHandle` but are
 * actually system/invite/content paths, not a channel. Dropped so discovery
 * keeps only real channels (spec: "non-channel results are dropped").
 */
const RESERVED: Record<Platform, ReadonlySet<string>> = {
  telegram: new Set([
    'joinchat', 'c', 's', 'share', 'addstickers', 'addtheme', 'addemoji',
    'proxy', 'socks', 'bg', 'login', 'iv', 'setlanguage', '+',
  ]),
  instagram: new Set([
    'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about',
    'directory', 'web', 'developer', 'legal', 'privacy',
  ]),
  youtube: new Set([
    'watch', 'shorts', 'results', 'playlist', 'feed', 'hashtag', 'gaming',
    'premium', 'account', 'embed', 'live',
  ]),
};

/**
 * Map search results to de-duplicated channel candidates. Each result URL is
 * tried against every platform's `parseHandle`; the first that yields a handle
 * (and isn't a reserved/system path) wins. `platform` narrows discovery to one
 * platform. Non-channel results are dropped.
 */
export function extractCandidates(
  results: YandexSearchResult[],
  opts: { platform?: Platform } = {},
): DiscoveredCandidate[] {
  const seen = new Set<string>();
  const out: DiscoveredCandidate[] = [];
  for (const r of results) {
    const url = (r.url ?? '').trim();
    if (!url) continue;
    for (const { platform, parse } of ADAPTERS) {
      if (opts.platform && opts.platform !== platform) continue;
      const parsed = parse(url);
      if (!parsed) continue;
      const handle = parsed.handle;
      // Normalize for reserved-check + dedup only (YouTube returns "@handle";
      // a bare custom path like "watch" comes back as "@watch"). The stored
      // handle keeps the adapter's canonical form.
      const norm = handle.replace(/^@/, '').toLowerCase();
      if (RESERVED[platform].has(norm)) continue;
      const key = `${platform}:${norm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform, handle, url, title: r.title ?? '' });
      break; // first matching platform wins
    }
  }
  return out;
}
