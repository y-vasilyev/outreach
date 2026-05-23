import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';

import {
  parseSearchXml,
  YandexSearchClient,
  type YandexSearchResult,
} from '../discovery/YandexSearchClient.js';
import { extractCandidates } from '../discovery/extractCandidates.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch><response><results><grouping><group>
  <doc><url>https://t.me/fintech_channel</url><title>Финтех <hlword>канал</hlword></title><passages><passage>Новости финтеха &amp; стартапов</passage></passages></doc>
  <doc><url>https://www.instagram.com/some.blogger</url><title>Blogger</title><headline>Личный блог</headline></doc>
  <doc><url>https://example.com/article/123</url><title>Статья</title></doc>
</group></grouping></results></response></yandexsearch>`;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('parseSearchXml', () => {
  it('extracts url/title/snippet per <doc>, decoding entities + stripping tags', () => {
    const res = parseSearchXml(SAMPLE_XML);
    expect(res.length).toBe(3);
    expect(res[0]).toMatchObject({
      url: 'https://t.me/fintech_channel',
      title: 'Финтех канал',
      snippet: 'Новости финтеха & стартапов',
    });
    expect(res[1]?.snippet).toBe('Личный блог'); // falls back to <headline>
  });

  it('returns [] for empty/garbage xml', () => {
    expect(parseSearchXml('')).toEqual([]);
    expect(parseSearchXml('<nope/>')).toEqual([]);
  });
});

describe('extractCandidates', () => {
  const results = (urls: string[]): YandexSearchResult[] =>
    urls.map((url) => ({ url, title: 't', snippet: 's' }));

  it('normalizes channel URLs to platform handles', () => {
    const c = extractCandidates(
      results([
        'https://t.me/fintech_channel',
        'https://instagram.com/some.blogger',
        'https://youtube.com/@cool.channel',
      ]),
    );
    expect(c).toEqual([
      expect.objectContaining({ platform: 'telegram', handle: 'fintech_channel' }),
      expect.objectContaining({ platform: 'instagram', handle: 'some.blogger' }),
      expect.objectContaining({ platform: 'youtube', handle: '@cool.channel' }),
    ]);
  });

  it('drops non-channel and system/invite URLs', () => {
    const c = extractCandidates(
      results([
        'https://example.com/article/123', // not a platform
        'https://t.me/joinchat/AAAA', // invite path (reserved)
        'https://youtube.com/watch?v=abc', // video, not a channel
        'https://instagram.com/p/XYZ', // post, not a profile
      ]),
    );
    expect(c).toEqual([]);
  });

  it('dedups within the batch and honors the platform filter', () => {
    const c = extractCandidates(
      results([
        'https://t.me/duped_channel',
        'https://t.me/duped_channel?start=1', // same handle, different query
        'https://instagram.com/ig_one',
      ]),
      { platform: 'telegram' },
    );
    expect(c).toEqual([
      expect.objectContaining({ platform: 'telegram', handle: 'duped_channel' }),
    ]);
  });
});

describe('YandexSearchClient', () => {
  it('submits, polls until done, and returns parsed results', async () => {
    const rawData = Buffer.from(SAMPLE_XML, 'utf8').toString('base64');
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/v2/web/searchAsync')) {
        expect(init?.method).toBe('POST');
        return jsonResponse({ id: 'op-1' });
      }
      // operation poll
      return jsonResponse({ done: true, response: { rawData } });
    }) as unknown as typeof fetch;

    const client = new YandexSearchClient({
      apiKey: 'k',
      folderId: 'f',
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 1000,
    });
    const res = await client.search('финтех каналы');
    expect(res.length).toBe(3);
    expect(res[0]?.url).toBe('https://t.me/fintech_channel');
  });

  it('throws a clear FORBIDDEN error on 403 (and does not leak the key)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Permission denied' }, 403)) as unknown as typeof fetch;
    const client = new YandexSearchClient({ apiKey: 'secret', folderId: 'f', fetchImpl });
    await expect(client.search('q')).rejects.toSatisfy((e: unknown) => {
      return isAppError(e) && e.statusCode === 403 && !JSON.stringify(e).includes('secret');
    });
  });

  it('returns [] (no hang/throw) when the operation never completes before timeout', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/v2/web/searchAsync')) return jsonResponse({ id: 'op-2' });
      return jsonResponse({ done: false });
    }) as unknown as typeof fetch;
    const client = new YandexSearchClient({
      apiKey: 'k',
      folderId: 'f',
      fetchImpl,
      pollIntervalMs: 2,
      pollTimeoutMs: 20,
    });
    await expect(client.search('q')).resolves.toEqual([]);
  });

  it('returns [] for an empty query without calling the API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new YandexSearchClient({ apiKey: 'k', folderId: 'f', fetchImpl });
    expect(await client.search('   ')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
