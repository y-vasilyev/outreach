import { z } from 'zod';
import { AppError } from '@nosquare/shared/errors';

export interface ScrapeCreatorsClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Optional logger (compatible with `pino`-shape). */
  logger?: {
    warn: (obj: unknown, msg?: string) => void;
    debug?: (obj: unknown, msg?: string) => void;
  };
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface InstagramProfile {
  user_id: string;
  username: string;
  full_name?: string;
  biography?: string;
  external_url?: string;
  follower_count?: number;
  posts_count?: number;
  raw: unknown;
}

export interface InstagramPost {
  id: string;
  taken_at_iso: string;
  caption: string;
  urls: string[];
}

export interface InstagramPostsResult {
  posts: InstagramPost[];
  raw: unknown;
}

export interface YoutubeChannel {
  channel_id: string;
  handle: string;
  title?: string;
  description?: string;
  links: string[];
  subscriber_count?: number;
  raw: unknown;
}

export interface YoutubeVideo {
  id: string;
  published_at_iso: string;
  title: string;
  description: string;
  urls: string[];
}

export interface YoutubeVideosResult {
  videos: YoutubeVideo[];
  raw: unknown;
}

const DEFAULT_BASE_URL = 'https://api.scrapecreators.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

// --- zod helpers (passthrough, lenient) ---------------------------------

const igProfileSchema = z
  .object({
    // ScrapeCreators returns variations across endpoints; allow nesting under `data`/`user`.
    user_id: z.union([z.string(), z.number()]).optional(),
    pk: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    username: z.string().optional(),
    full_name: z.string().optional(),
    biography: z.string().optional(),
    external_url: z.string().optional(),
    bio_links: z
      .array(z.object({ url: z.string().optional() }).passthrough())
      .optional(),
    follower_count: z.number().optional(),
    edge_followed_by: z.object({ count: z.number().optional() }).passthrough().optional(),
    media_count: z.number().optional(),
    edge_owner_to_timeline_media: z
      .object({ count: z.number().optional() })
      .passthrough()
      .optional(),
    user: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const igPostsSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    posts: z.array(z.unknown()).optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const ytChannelSchema = z
  .object({
    channel_id: z.string().optional(),
    channelId: z.string().optional(),
    id: z.string().optional(),
    handle: z.string().optional(),
    title: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    subscriber_count: z.number().optional(),
    subscriberCount: z.union([z.string(), z.number()]).optional(),
    subscribers: z.union([z.string(), z.number()]).optional(),
    links: z.array(z.unknown()).optional(),
    external_links: z.array(z.unknown()).optional(),
    channel: z.unknown().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const ytVideosSchema = z
  .object({
    videos: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

// --- field extraction helpers -------------------------------------------

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function getProp(obj: unknown, key: string): unknown {
  if (obj && typeof obj === 'object' && key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function pickRecord(obj: unknown): Record<string, unknown> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return obj as Record<string, unknown>;
  }
  return {};
}

function unwrapNested(obj: unknown, keys: string[]): Record<string, unknown> {
  let current = pickRecord(obj);
  for (const k of keys) {
    const inner = current[k];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      current = { ...current, ...(inner as Record<string, unknown>) };
    }
  }
  return current;
}

function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s)>\]]+/gi;
  return Array.from(text.matchAll(re), (m) => m[0]);
}

const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{20,30}$/;

/**
 * Build the identifier query for ScrapeCreators YouTube endpoints.
 * - `UC…` → `channelId`
 * - `@handle` or bare handle → `handle` (without leading `@`, since the API expects `ThePatMcAfeeShow`)
 * - full URL → `url` by default; with `resolveUrl: true` we extract `channelId`/`handle` from the URL because
 *   `/v1/youtube/channel-videos` does not accept a `url` param.
 */
function ytIdentifierQuery(
  input: string,
  opts: { resolveUrl?: boolean } = {},
): Record<string, string> {
  const trimmed = input.trim();
  if (YT_CHANNEL_ID_RE.test(trimmed)) return { channelId: trimmed };
  if (!/^https?:\/\//i.test(trimmed)) {
    const handle = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
    return { handle };
  }
  if (opts.resolveUrl) {
    const path = trimmed.replace(/^https?:\/\/[^/]+\//i, '').split(/[?#]/)[0] ?? '';
    if (path.startsWith('channel/')) {
      const id = path.slice('channel/'.length).split('/')[0] ?? '';
      if (YT_CHANNEL_ID_RE.test(id)) return { channelId: id };
    }
    if (path.startsWith('@')) {
      const h = path.split('/')[0]?.slice(1) ?? '';
      if (h) return { handle: h };
    }
  }
  return { url: trimmed };
}

function isoFromMaybe(v: unknown): string {
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.valueOf())) return d.toISOString();
    // sometimes a numeric string seconds:
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return new Date(n * (n < 1e12 ? 1000 : 1)).toISOString();
    return new Date(0).toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return new Date(0).toISOString();
}

// --- the client ----------------------------------------------------------

export class ScrapeCreatorsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger: ScrapeCreatorsClientOptions['logger'];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ScrapeCreatorsClientOptions) {
    if (!opts.apiKey) {
      throw new AppError('BAD_REQUEST', 'ScrapeCreatorsClient: apiKey required', 400);
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ---------- Instagram ----------

  async getInstagramProfile(handle: string): Promise<InstagramProfile> {
    const raw = await this.request<unknown>('/v1/instagram/profile', { handle });
    const parsed = igProfileSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { issues: parsed.error.issues },
        'scrapecreators: instagram profile schema mismatch',
      );
    }
    const merged = unwrapNested(raw, ['data', 'user']);

    const userId =
      asString(getProp(merged, 'user_id')) ??
      asString(getProp(merged, 'pk')) ??
      asString(getProp(merged, 'id')) ??
      '';
    const username = asString(getProp(merged, 'username')) ?? handle;
    const fullName = asString(getProp(merged, 'full_name'));
    const biography = asString(getProp(merged, 'biography'));
    const bioLinks = getProp(merged, 'bio_links');
    let externalUrl = asString(getProp(merged, 'external_url'));
    if (!externalUrl && Array.isArray(bioLinks) && bioLinks.length > 0) {
      const firstBio = bioLinks[0];
      externalUrl = asString(getProp(pickRecord(firstBio), 'url'));
    }

    const followerCount =
      asNumber(getProp(merged, 'follower_count')) ??
      asNumber(getProp(pickRecord(getProp(merged, 'edge_followed_by')), 'count'));

    const postsCount =
      asNumber(getProp(merged, 'media_count')) ??
      asNumber(getProp(pickRecord(getProp(merged, 'edge_owner_to_timeline_media')), 'count'));

    return {
      user_id: userId,
      username,
      full_name: fullName,
      biography,
      external_url: externalUrl,
      follower_count: followerCount,
      posts_count: postsCount,
      raw,
    };
  }

  async getInstagramPosts(
    handle: string,
    opts: { limit?: number } = {},
  ): Promise<InstagramPostsResult> {
    const limit = opts.limit ?? 12;
    const raw = await this.request<unknown>('/v1/instagram/user/posts', {
      handle,
      limit,
    });
    const parsed = igPostsSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { issues: parsed.error.issues },
        'scrapecreators: instagram posts schema mismatch',
      );
    }

    const itemsRaw =
      (getProp(raw, 'items') as unknown[] | undefined) ??
      (getProp(raw, 'posts') as unknown[] | undefined) ??
      (getProp(pickRecord(getProp(raw, 'data')), 'items') as unknown[] | undefined) ??
      [];

    const posts: InstagramPost[] = itemsRaw.map((item) => {
      const r = pickRecord(item);
      const id =
        asString(getProp(r, 'id')) ??
        asString(getProp(r, 'pk')) ??
        asString(getProp(r, 'code')) ??
        asString(getProp(r, 'shortcode')) ??
        '';
      const captionRaw = getProp(r, 'caption');
      const caption =
        asString(captionRaw) ??
        asString(getProp(pickRecord(captionRaw), 'text')) ??
        '';
      const taken =
        getProp(r, 'taken_at') ??
        getProp(r, 'taken_at_timestamp') ??
        getProp(r, 'created_at');
      return {
        id,
        taken_at_iso: isoFromMaybe(taken),
        caption,
        urls: extractUrls(caption),
      };
    });

    return { posts, raw };
  }

  // ---------- YouTube ----------

  async getYoutubeChannel(handleOrUrl: string): Promise<YoutubeChannel> {
    const query = ytIdentifierQuery(handleOrUrl);
    const raw = await this.request<unknown>('/v1/youtube/channel', query);
    const parsed = ytChannelSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { issues: parsed.error.issues },
        'scrapecreators: youtube channel schema mismatch',
      );
    }
    const merged = unwrapNested(raw, ['data', 'channel']);

    const channelId =
      asString(getProp(merged, 'channel_id')) ??
      asString(getProp(merged, 'channelId')) ??
      asString(getProp(merged, 'id')) ??
      '';
    const handle =
      asString(getProp(merged, 'handle')) ??
      (handleOrUrl.startsWith('@') ? handleOrUrl : '');
    const title =
      asString(getProp(merged, 'title')) ?? asString(getProp(merged, 'name'));
    const description = asString(getProp(merged, 'description'));
    const subscriberCount =
      asNumber(getProp(merged, 'subscriber_count')) ??
      asNumber(getProp(merged, 'subscriberCount')) ??
      asNumber(getProp(merged, 'subscribers'));

    const linksRaw =
      (getProp(merged, 'links') as unknown[] | undefined) ??
      (getProp(merged, 'external_links') as unknown[] | undefined) ??
      [];
    const links = linksRaw
      .map((l) => {
        if (typeof l === 'string') return l;
        const r = pickRecord(l);
        return (
          asString(getProp(r, 'url')) ??
          asString(getProp(r, 'href')) ??
          asString(getProp(r, 'link')) ??
          undefined
        );
      })
      .filter((u): u is string => typeof u === 'string' && u.length > 0);

    return {
      channel_id: channelId,
      handle,
      title,
      description,
      links,
      subscriber_count: subscriberCount,
      raw,
    };
  }

  async getYoutubeVideos(
    channelIdOrHandle: string,
    opts: { limit?: number } = {},
  ): Promise<YoutubeVideosResult> {
    const limit = opts.limit ?? 12;
    // /v1/youtube/channel-videos accepts only `channelId` or `handle` (no `url`).
    // Resolve a URL to its handle/channelId before calling.
    const query = ytIdentifierQuery(channelIdOrHandle, { resolveUrl: true });
    const raw = await this.request<unknown>('/v1/youtube/channel-videos', query);
    const parsed = ytVideosSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { issues: parsed.error.issues },
        'scrapecreators: youtube videos schema mismatch',
      );
    }

    const itemsRaw =
      (getProp(raw, 'videos') as unknown[] | undefined) ??
      (getProp(raw, 'items') as unknown[] | undefined) ??
      (getProp(pickRecord(getProp(raw, 'data')), 'videos') as unknown[] | undefined) ??
      [];

    const videos: YoutubeVideo[] = itemsRaw.slice(0, limit).map((item) => {
      const r = pickRecord(item);
      const id =
        asString(getProp(r, 'id')) ??
        asString(getProp(r, 'video_id')) ??
        asString(getProp(r, 'videoId')) ??
        '';
      const title = asString(getProp(r, 'title')) ?? '';
      const description =
        asString(getProp(r, 'description')) ??
        asString(getProp(r, 'snippet_description')) ??
        '';
      const published =
        getProp(r, 'publishedTime') ??
        getProp(r, 'published_at') ??
        getProp(r, 'publishedAt') ??
        getProp(r, 'publish_date') ??
        getProp(r, 'published_time') ??
        getProp(r, 'publishedTimeText');
      return {
        id,
        published_at_iso: isoFromMaybe(published),
        title,
        description,
        urls: extractUrls(`${title}\n${description}`),
      };
    });

    return { videos, raw };
  }

  // ---------- HTTP core ----------

  private async request<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            'x-api-key': this.apiKey,
            accept: 'application/json',
          },
          signal: ac.signal,
        });

        if (res.status >= 500 || res.status === 429) {
          const body = await safeText(res);
          lastErr = new AppError(
            'UPSTREAM_ERROR',
            `scrapecreators: ${res.status} ${res.statusText}`,
            502,
            { status: res.status, body },
          );
          if (attempt < this.maxRetries) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          const body = await safeText(res);
          throw new AppError(
            'UPSTREAM_ERROR',
            `scrapecreators: ${res.status} ${res.statusText}`,
            502,
            { status: res.status, body },
          );
        }

        const json = (await res.json()) as T;
        return json;
      } catch (err) {
        lastErr = err;
        // network/abort errors → retry
        const retryable = isRetryable(err);
        if (retryable && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (err instanceof AppError) throw err;
        throw new AppError(
          'UPSTREAM_ERROR',
          `scrapecreators: ${(err as Error)?.message ?? 'request failed'}`,
          502,
          { cause: String(err) },
        );
      } finally {
        clearTimeout(t);
      }
    }
    // Should be unreachable
    if (lastErr instanceof AppError) throw lastErr;
    throw new AppError('UPSTREAM_ERROR', 'scrapecreators: exhausted retries', 502);
  }
}

function backoffMs(attempt: number): number {
  // 200, 500, 1200 (jittered)
  const base = 200 * Math.pow(2.5, attempt);
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(5_000, Math.floor(base) + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as { name?: string; code?: string; message?: string })?.message ?? '';
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'AbortError') return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) return true;
  return false;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
