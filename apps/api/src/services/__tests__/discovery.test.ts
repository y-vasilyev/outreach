import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';

/**
 * Discovery service (channel-discovery-search M2): search → normalize →
 * persist NEW channels + enqueue scrape; known channels are not duplicated or
 * re-enqueued; a missing integration is a clear error. Search client, prisma,
 * decrypt and the queue are mocked (no network/DB/Redis).
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    integration: { findUnique: vi.fn() },
    channel: { findUnique: vi.fn(), create: vi.fn() },
  };
  const scrapeAdd = vi.fn(async () => ({}));
  const searchResults = vi.fn(async () => [] as Array<{ url: string; title: string; snippet: string }>);
  const candidates = vi.fn(
    (..._args: unknown[]) => [] as Array<{ platform: string; handle: string; url: string; title: string }>,
  );
  const decrypt = vi.fn(async () => ({ apiKey: 'k', folderId: 'f' }));
  return { prisma, scrapeAdd, searchResults, candidates, decrypt };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma, decryptJson: mocks.decrypt }));
vi.mock('../../queues.js', () => ({ getQueues: () => ({ channelScrape: { add: mocks.scrapeAdd } }) }));
vi.mock('@nosquare/platforms', () => ({
  YandexSearchClient: class {
    search = mocks.searchResults;
  },
  extractCandidates: (...args: unknown[]) => mocks.candidates(...args),
}));

import { discoveryService } from '../discovery.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.integration.findUnique.mockResolvedValue({
    kind: 'yandex_search',
    enabled: true,
    configEncrypted: 'enc',
  });
  mocks.decrypt.mockResolvedValue({ apiKey: 'k', folderId: 'f' });
  mocks.searchResults.mockResolvedValue([{ url: 'https://t.me/x', title: 't', snippet: 's' }]);
  mocks.prisma.channel.create.mockResolvedValue({ id: 'ch_new' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('discoveryService.search', () => {
  it('persists NEW candidates and enqueues a scrape; counts known without duplicating', async () => {
    mocks.candidates.mockReturnValue([
      { platform: 'telegram', handle: 'new_chan', url: 'https://t.me/new_chan', title: 'A' },
      { platform: 'telegram', handle: 'known_chan', url: 'https://t.me/known_chan', title: 'B' },
    ]);
    // first candidate is new (null), second already exists
    mocks.prisma.channel.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ch_known' });
    mocks.prisma.channel.create.mockResolvedValue({ id: 'ch_new' });

    const res = await discoveryService.search({ query: 'финтех', limit: 20 }, 'u1');

    expect(res).toMatchObject({ query: 'финтех', created: 1, enqueued: 1, alreadyKnown: 1 });
    expect(mocks.prisma.channel.create).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.channel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ platform: 'telegram', handle: 'new_chan', status: 'new', source: 'search:финтех' }),
      }),
    );
    // scrape enqueued only for the newly-created channel
    expect(mocks.scrapeAdd).toHaveBeenCalledTimes(1);
    expect(mocks.scrapeAdd).toHaveBeenCalledWith('scrape', { channelId: 'ch_new' });
    // candidate flags reflect known vs new
    expect(res.candidates.find((c) => c.handle === 'known_chan')?.alreadyKnown).toBe(true);
    expect(res.candidates.find((c) => c.handle === 'new_chan')?.alreadyKnown).toBe(false);
  });

  it('handles a findUnique→create race without 500ing (counts as known, no enqueue)', async () => {
    mocks.candidates.mockReturnValue([
      { platform: 'telegram', handle: 'racy_chan', url: 'https://t.me/racy_chan', title: '' },
    ]);
    mocks.prisma.channel.findUnique.mockResolvedValue(null); // looked free…
    mocks.prisma.channel.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }), // …but created concurrently
    );

    const res = await discoveryService.search({ query: 'q', limit: 20 }, 'u1');
    expect(res).toMatchObject({ created: 0, enqueued: 0, alreadyKnown: 1 });
    expect(mocks.scrapeAdd).not.toHaveBeenCalled();
    expect(res.candidates[0]?.alreadyKnown).toBe(true);
  });

  it('respects the limit (slices candidates)', async () => {
    mocks.candidates.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => ({
        platform: 'telegram',
        handle: `chan_${i}`,
        url: `https://t.me/chan_${i}`,
        title: '',
      })),
    );
    mocks.prisma.channel.findUnique.mockResolvedValue(null);
    mocks.prisma.channel.create.mockImplementation(async () => ({ id: `ch_${Math.random()}` }));

    const res = await discoveryService.search({ query: 'q', limit: 2 }, null);
    expect(res.created).toBe(2);
    expect(mocks.prisma.channel.create).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when the yandex_search integration is missing', async () => {
    mocks.prisma.integration.findUnique.mockResolvedValue(null);
    await expect(discoveryService.search({ query: 'q', limit: 20 }, 'u1')).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.statusCode === 400,
    );
    expect(mocks.prisma.channel.create).not.toHaveBeenCalled();
  });

  it('throws when the integration is disabled', async () => {
    mocks.prisma.integration.findUnique.mockResolvedValue({ enabled: false, configEncrypted: 'e' });
    await expect(discoveryService.search({ query: 'q', limit: 20 }, 'u1')).rejects.toSatisfy(
      (e: unknown) => isAppError(e),
    );
  });
});
