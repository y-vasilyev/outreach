import { describe, it, expect } from 'vitest';

/**
 * Env-gated live integration test for guided discovery's web-search core
 * (ajtbd-guided-blogger-discovery, task 7.3).
 *
 * Exercises the traceable multi-query search layer the guided-discovery worker
 * uses (`executePlannedSearches` over a real `YandexSearchClient`) against the
 * real Yandex Search API: a planner-style multi-query plan returns ≥1 channel
 * candidate with cross-query provenance and one sanitized trace record per
 * planned query.
 *
 * Skips cleanly when Search credentials are absent (mirrors the channel
 * discovery e2e + MinIO skip-if-unavailable pattern), so offline CI is
 * unaffected. The LLM planner/reviewer stages are intentionally NOT exercised
 * here — this test isolates the live Yandex dependency.
 *
 * Run: YANDEX_SEARCH_API_KEY=… YANDEX_SEARCH_FOLDER_ID=… pnpm test
 */
const searchKey = process.env.YANDEX_SEARCH_API_KEY || process.env.YANDEX_API_KEY;
const folder =
  process.env.YANDEX_SEARCH_FOLDER_ID ||
  process.env.YANDEX_DEFAULT_FOLDER_ID ||
  process.env.YANDEX_FOLDER_ID;
const ENABLED = Boolean(searchKey && folder);

describe.skipIf(!ENABLED)('e2e: guided discovery live Yandex search core', () => {
  it('executes a multi-query plan → candidates with provenance + per-query trace', async () => {
    const { YandexSearchClient, executePlannedSearches } = await import('@nosquare/platforms');
    const client = new YandexSearchClient({ apiKey: searchKey as string, folderId: folder as string });

    const planned = [
      { query: 'телеграм каналы про финтех', platform: 'telegram' as const },
      { query: 'каналы про стартапы и инвестиции', platform: 'telegram' as const },
    ];
    const { candidates, trace } = await executePlannedSearches(client, planned, {
      limitPerQuery: 10,
      maxCandidates: 30,
    });

    // One sanitized trace record per planned query — and no secret material.
    expect(trace).toHaveLength(planned.length);
    const serialized = JSON.stringify(trace).toLowerCase();
    expect(serialized).not.toContain(String(searchKey).toLowerCase());
    expect(serialized).not.toContain(String(folder).toLowerCase());

    // The live search produced real channel candidates with provenance.
    expect(candidates.length).toBeGreaterThan(0);
    const top = candidates[0]!;
    expect(top.platform).toBe('telegram');
    expect(top.handle.length).toBeGreaterThan(0);
    expect(top.sourceQueries.length).toBeGreaterThan(0);
    expect(planned.map((p) => p.query)).toContain(top.sourceQuery);
  }, 90_000);
});
