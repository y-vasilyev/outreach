import { describe, expect, it, vi } from 'vitest';

import {
  executePlannedSearches,
  type DiscoverySearchClient,
} from '../discovery/executeSearch.js';
import type { YandexSearchResult } from '../discovery/YandexSearchClient.js';

/**
 * Traceable multi-query search core (ajtbd-guided-blogger-discovery, task 3.4).
 * Covers multi-query success, isolated per-query failure, duplicate
 * provenance across queries, and that the trace carries no secret material.
 */

function res(url: string, title = ''): YandexSearchResult {
  return { url, title, snippet: '' } as YandexSearchResult;
}

describe('executePlannedSearches', () => {
  it('aggregates candidates across multiple queries with per-query trace', async () => {
    const client: DiscoverySearchClient = {
      search: vi.fn(async (q: string) =>
        q.includes('финтех') ? [res('https://t.me/fintech_a', 'A')] : [res('https://t.me/cook_b', 'B')],
      ),
    };
    const out = await executePlannedSearches(
      client,
      [
        { query: 'финтех', platform: 'telegram' },
        { query: 'кулинария', platform: 'telegram' },
      ],
      { limitPerQuery: 20 },
    );
    expect(out.candidates).toHaveLength(2);
    expect(out.trace).toHaveLength(2);
    expect(out.trace.every((t) => t.status === 'ok')).toBe(true);
    expect(out.trace[0]!.candidateCount).toBe(1);
    expect(out.trace[0]!.query).toBe('финтех');
    expect(out.trace[0]!.platform).toBe('telegram');
  });

  it('isolates a query-level failure and still returns other candidates', async () => {
    const client: DiscoverySearchClient = {
      search: vi.fn(async (q: string) => {
        if (q.includes('boom')) throw new Error('Yandex 503');
        return [res('https://t.me/ok_chan', 'OK')];
      }),
    };
    const out = await executePlannedSearches(
      client,
      [
        { query: 'boom', platform: 'telegram' },
        { query: 'good', platform: 'telegram' },
      ],
      { limitPerQuery: 20 },
    );
    expect(out.candidates).toHaveLength(1);
    const failed = out.trace.find((t) => t.query === 'boom')!;
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('503');
    const ok = out.trace.find((t) => t.query === 'good')!;
    expect(ok.status).toBe('ok');
  });

  it('de-dupes a candidate found by multiple queries, merging provenance', async () => {
    const client: DiscoverySearchClient = {
      search: vi.fn(async () => [res('https://t.me/shared', 'Shared')]),
    };
    const out = await executePlannedSearches(
      client,
      [
        { query: 'q1', platform: 'telegram' },
        { query: 'q2', platform: 'telegram' },
      ],
      { limitPerQuery: 20 },
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.sourceQueries).toEqual(['q1', 'q2']);
    expect(out.candidates[0]!.sourceQuery).toBe('q1');
  });

  it('caps the total de-duplicated candidates at maxCandidates', async () => {
    const client: DiscoverySearchClient = {
      search: vi.fn(async () => [
        res('https://t.me/alpha_chan'),
        res('https://t.me/beta_chan'),
        res('https://t.me/gamma_chan'),
      ]),
    };
    const out = await executePlannedSearches(
      client,
      [{ query: 'q', platform: 'telegram' }],
      { limitPerQuery: 20, maxCandidates: 2 },
    );
    expect(out.candidates).toHaveLength(2);
  });

  it('trace metadata never carries secret/key material', async () => {
    const client: DiscoverySearchClient = {
      search: vi.fn(async () => [res('https://t.me/x')]),
    };
    const out = await executePlannedSearches(client, [{ query: 'q', platform: 'telegram' }], {});
    const serialized = JSON.stringify(out.trace).toLowerCase();
    expect(serialized).not.toContain('apikey');
    expect(serialized).not.toContain('folderid');
    expect(serialized).not.toContain('secret');
    // Only the sanitized fields are present.
    const keys = Object.keys(out.trace[0]!).sort();
    expect(keys).toEqual(
      ['candidateCount', 'completedAt', 'platform', 'query', 'resultCount', 'startedAt', 'status'].sort(),
    );
  });
});
