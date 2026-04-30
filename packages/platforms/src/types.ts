export type Platform = 'telegram' | 'instagram' | 'youtube';

/**
 * Structural subset of the tg-client surface we need for scraping.
 * The parallel `@nosquare/tg-client` package exposes these methods on its
 * per-account handle (`TelegramClientHandle`); the worker is responsible
 * for resolving the handle and passing it in via `ScrapeCtx.tgClient`.
 *
 * Keeping this structural avoids tight coupling and lets the parallel
 * agent evolve `TgClient` without breaking us — as long as the shape
 * satisfies this interface, scraping works.
 */
export interface TgScrapeClient {
  resolveChannel(handle: string): Promise<{
    id: string | number | bigint;
    accessHash?: string | number | bigint;
    title?: string;
    about?: string;
    participantsCount?: number;
    language?: string;
    linkedChat?: { id: string; accessHash: string; handle?: string };
    raw?: unknown;
  }>;
  getRecentPosts(
    handle: string,
    limit: number,
  ): Promise<
    Array<{
      id: number;
      dateIso: string;
      text: string;
      urls: string[];
    }>
  >;
}

export interface ScrapeCtx {
  signal?: AbortSignal;
  // Telegram needs a parser tg account session — passed in from the worker:
  tgClient?: TgScrapeClient;
  scrapeCreators?: import('./scrapecreators/Client.js').ScrapeCreatorsClient;
}

export interface ChannelSnapshotPost {
  id: string;
  date: string; // ISO
  text: string;
  urls: string[];
}

export interface ChannelSnapshot {
  platform: Platform;
  externalId: string;
  handle: string;
  title: string;
  description: string;
  links: string[];
  followers?: number;
  language?: string;
  posts: ChannelSnapshotPost[];
  raw: unknown;
}

export interface PlatformAdapter {
  platform: Platform;
  parseHandle(input: string): { handle: string } | null;
  scrapeChannel(handle: string, ctx: ScrapeCtx): Promise<ChannelSnapshot>;
}
