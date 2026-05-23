import { describe, it, expect, beforeAll } from 'vitest';

/**
 * E2E that CLOSES the channel-discovery business scenario against the real
 * Yandex Search API + real DB: a niche query discovers ≥1 telegram channel,
 * persists it as a `channel(status='new')`, and enqueues a scrape — the front
 * of the agency-sourcing funnel.
 *
 * Env-gated: runs only with a real Search-API key + folder AND a real (non-stub)
 * DATABASE_URL. Skips cleanly otherwise so offline CI is unaffected
 * (mirrors the MinIO integration test's skip-if-unavailable pattern).
 *
 * Run: YANDEX_SEARCH_API_KEY=… YANDEX_SEARCH_FOLDER_ID=… plus a real .env
 * (DATABASE_URL/REDIS_URL/ENCRYPTION_KEY/…) loaded.
 */
const searchKey = process.env.YANDEX_SEARCH_API_KEY || process.env.YANDEX_API_KEY;
const folder =
  process.env.YANDEX_SEARCH_FOLDER_ID ||
  process.env.YANDEX_DEFAULT_FOLDER_ID ||
  process.env.YANDEX_FOLDER_ID;
const dbReal = Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test'));
const ENABLED = Boolean(searchKey && folder && dbReal);

describe.skipIf(!ENABLED)('e2e: channel discovery closes the business scenario', () => {
  beforeAll(async () => {
    // Ensure the yandex_search integration is configured (encrypted) so the
    // discovery service can decrypt it — self-contained, no pre-seed required.
    const { getPrisma, encryptJson } = await import('@nosquare/db');
    const configEncrypted = await encryptJson({ apiKey: searchKey, folderId: folder });
    await getPrisma().integration.upsert({
      where: { kind: 'yandex_search' },
      update: { configEncrypted, enabled: true, status: 'configured' },
      create: { kind: 'yandex_search', configEncrypted, enabled: true, status: 'configured' },
    });
  });

  it('discovers ≥1 telegram channel, persists it (status=new) and enqueues a scrape', async () => {
    const { discoveryService } = await import('../discovery.js');
    const { getPrisma } = await import('@nosquare/db');

    const res = await discoveryService.search(
      { query: 'телеграм каналы про финтех', platform: 'telegram', limit: 5 },
      null,
    );

    // Real search → real candidates: the scenario produced channel candidates.
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.created + res.alreadyKnown).toBe(res.candidates.length);

    // The discovered channel is now in the intake (status=new), ready to scrape.
    const top = res.candidates[0]!;
    const ch = await getPrisma().channel.findUnique({
      where: { platform_handle: { platform: top.platform, handle: top.handle } },
      select: { status: true, source: true },
    });
    expect(ch).not.toBeNull();
    expect(ch?.status).toBe('new');
    expect(ch?.source).toContain('search:');
  }, 90_000);
});
