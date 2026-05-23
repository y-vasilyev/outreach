import { AppError } from '@nosquare/shared/errors';

/**
 * Yandex Cloud Search API v2 client (channel-discovery-search change).
 *
 * NB: this is the SEARCH API (web search), distinct from the Yandex
 * Foundation Models LLM API — it just shares Yandex Cloud `Api-Key` auth +
 * folderId. Web search is async: submit → poll the operation → decode the
 * base64 result XML. Bounded by `pollTimeoutMs` so it never hangs; returns an
 * empty result set on a miss/timeout and a clear AppError on a credential
 * failure. Never logs the API key.
 */

export interface YandexSearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface YandexSearchClientOptions {
  apiKey: string;
  folderId: string;
  baseUrl?: string;
  operationBaseUrl?: string;
  /** Max time to poll the async operation before giving up. Default 45s. */
  pollTimeoutMs?: number;
  /** Poll interval. Default 3s. */
  pollIntervalMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug?: (obj: unknown, msg?: string) => void };
}

export interface YandexSearchOptions {
  /** SEARCH_TYPE_RU | SEARCH_TYPE_TR | SEARCH_TYPE_COM. Default RU. */
  searchType?: string;
}

const DEFAULT_BASE_URL = 'https://searchapi.api.cloud.yandex.net';
const DEFAULT_OPERATION_BASE_URL = 'https://operation.api.cloud.yandex.net';

export class YandexSearchClient {
  private readonly cfg: Required<
    Pick<YandexSearchClientOptions, 'apiKey' | 'folderId' | 'pollTimeoutMs' | 'pollIntervalMs'>
  > & {
    baseUrl: string;
    operationBaseUrl: string;
    fetchImpl: typeof fetch;
    logger?: YandexSearchClientOptions['logger'];
  };

  constructor(opts: YandexSearchClientOptions) {
    this.cfg = {
      apiKey: opts.apiKey,
      folderId: opts.folderId,
      baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
      operationBaseUrl: opts.operationBaseUrl || DEFAULT_OPERATION_BASE_URL,
      pollTimeoutMs: opts.pollTimeoutMs ?? 45_000,
      pollIntervalMs: opts.pollIntervalMs ?? 3_000,
      fetchImpl: opts.fetchImpl ?? fetch,
      logger: opts.logger,
    };
  }

  private headers(): Record<string, string> {
    return { Authorization: `Api-Key ${this.cfg.apiKey}`, 'Content-Type': 'application/json' };
  }

  /** Run a web search and return parsed results (never throws on a miss). */
  async search(query: string, opts: YandexSearchOptions = {}): Promise<YandexSearchResult[]> {
    const q = (query ?? '').trim();
    if (!q) return [];

    const operationId = await this.submit(q, opts.searchType ?? 'SEARCH_TYPE_RU');
    const rawXml = await this.pollForResult(operationId);
    if (!rawXml) return [];
    return parseSearchXml(rawXml);
  }

  private async submit(queryText: string, searchType: string): Promise<string> {
    const url = `${this.cfg.baseUrl}/v2/web/searchAsync`;
    const res = await this.cfg.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query: { searchType, queryText }, folderId: this.cfg.folderId }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      if (res.status === 403) {
        throw new AppError(
          'FORBIDDEN',
          'yandex search: permission denied — the key/service account lacks Search API access',
          403,
          { status: 403 },
        );
      }
      throw new AppError('UPSTREAM', `yandex search submit failed (${res.status})`, 502, {
        status: res.status,
        body: body.slice(0, 300),
      });
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new AppError('UPSTREAM', 'yandex search: submit returned no operation id', 502);
    }
    return json.id;
  }

  /** Poll the operation until done or the timeout; returns the result XML or null. */
  private async pollForResult(operationId: string): Promise<string | null> {
    const deadline = Date.now() + this.cfg.pollTimeoutMs;
    const url = `${this.cfg.operationBaseUrl}/operations/${operationId}`;
    while (Date.now() < deadline) {
      await sleep(this.cfg.pollIntervalMs);
      let op: { done?: boolean; error?: unknown; response?: { rawData?: string } };
      try {
        const res = await this.cfg.fetchImpl(url, { headers: this.headers() });
        if (!res.ok) {
          // Transient operation read error — keep polling within the deadline.
          continue;
        }
        op = (await res.json()) as typeof op;
      } catch {
        continue;
      }
      if (!op.done) continue;
      if (op.error) {
        throw new AppError('UPSTREAM', 'yandex search: operation finished with an error', 502, {
          error: op.error,
        });
      }
      const raw = op.response?.rawData;
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf8');
    }
    this.cfg.logger?.warn(
      { operationId, pollTimeoutMs: this.cfg.pollTimeoutMs },
      'yandex search: operation did not complete before timeout',
    );
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Parse the Yandex Search result XML into `{ url, title, snippet }[]`. Lenient
 * by design: extracts per-`<doc>` `<url>` + `<title>` (+ first passage as
 * snippet), tolerating missing fields and inline highlight tags. Exported for
 * unit testing against a captured sample.
 */
export function parseSearchXml(xml: string): YandexSearchResult[] {
  const out: YandexSearchResult[] = [];
  const docRe = /<doc\b[^>]*>([\s\S]*?)<\/doc>/g;
  let m: RegExpExecArray | null;
  while ((m = docRe.exec(xml)) !== null) {
    const doc = m[1] ?? '';
    const url = stripTags(firstTag(doc, 'url'));
    if (!url) continue;
    const title = stripTags(firstTag(doc, 'title'));
    const snippet = stripTags(firstTag(doc, 'passage') || firstTag(doc, 'headline'));
    out.push({ url, title, snippet });
  }
  return out;
}

function firstTag(s: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(s);
  return m?.[1] ?? '';
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
