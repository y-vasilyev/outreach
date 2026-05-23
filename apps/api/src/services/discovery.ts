import { getPrisma, decryptJson } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import type { DiscoverySearchInput, DiscoveryResult } from '@nosquare/shared';
import { YandexSearchClient, extractCandidates } from '@nosquare/platforms';

import { getQueues } from '../queues.js';

/**
 * Channel discovery via web search (channel-discovery-search change).
 *
 * Runs a Yandex web search for a niche, normalizes results to platform
 * channel handles, persists NEW ones as `channel(status='new')` and enqueues
 * the existing `channel-scrape` job — so discovered channels flow through the
 * unchanged scrape → contact-extract intake. Known channels are neither
 * duplicated nor re-enqueued.
 */

interface YandexSearchConfig {
  apiKey: string;
  folderId: string;
  baseUrl?: string;
}

export const discoveryService = {
  async search(input: DiscoverySearchInput, addedById: string | null): Promise<DiscoveryResult> {
    const prisma = getPrisma();

    const integ = await prisma.integration.findUnique({ where: { kind: 'yandex_search' } });
    if (!integ || !integ.enabled) {
      throw Errors.badRequest('yandex_search integration is not configured or disabled');
    }
    const cfg = await decryptJson<YandexSearchConfig>(integ.configEncrypted);
    if (!cfg?.apiKey || !cfg?.folderId) {
      throw Errors.badRequest('yandex_search integration is missing apiKey/folderId');
    }

    const client = new YandexSearchClient({
      apiKey: cfg.apiKey,
      folderId: cfg.folderId,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    });
    const results = await client.search(input.query);
    const candidates = extractCandidates(
      results,
      input.platform ? { platform: input.platform } : {},
    ).slice(0, input.limit);

    const queues = getQueues();
    const source = `search:${input.query}`;
    let created = 0;
    let enqueued = 0;
    let alreadyKnown = 0;
    const out: DiscoveryResult['candidates'] = [];

    for (const c of candidates) {
      const existing = await prisma.channel.findUnique({
        where: { platform_handle: { platform: c.platform, handle: c.handle } },
        select: { id: true },
      });
      if (existing) {
        alreadyKnown += 1;
        out.push({ platform: c.platform, handle: c.handle, url: c.url, title: c.title, alreadyKnown: true });
        continue;
      }
      let ch: { id: string };
      try {
        ch = await prisma.channel.create({
          data: {
            platform: c.platform,
            handle: c.handle,
            status: 'new',
            source,
            addedById,
            links: [],
          },
        });
      } catch {
        // Lost a findUnique→create race (the @@unique(platform,handle) fired)
        // or the row was created concurrently — it now exists, so count it as
        // already-known and don't enqueue a duplicate scrape. Never 500 the
        // whole discovery on one candidate.
        alreadyKnown += 1;
        out.push({ platform: c.platform, handle: c.handle, url: c.url, title: c.title, alreadyKnown: true });
        continue;
      }
      created += 1;
      await queues.channelScrape.add('scrape', { channelId: ch.id });
      enqueued += 1;
      out.push({ platform: c.platform, handle: c.handle, url: c.url, title: c.title, alreadyKnown: false });
    }

    return { query: input.query, candidates: out, created, enqueued, alreadyKnown };
  },
};
