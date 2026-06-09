import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadPublicPostMediaWithClient,
  type DownloadMediaClient,
} from '../SessionManager.js';

/**
 * Unit tests for the helper backing `handle.downloadPublicPostMedia`
 * (blogger-profile-who-is-this). Mirrors the inbound-media contract: every
 * failure mode resolves to `null` (never throws), so the post-image worker can
 * mark `unsupported`/`failed` instead of crashing the scrape.
 */

const ACCOUNT_ID = 'parser-default';
const OPTS = { handle: '@tomnayaa', postId: '1317' };

function makeClient(overrides: Partial<DownloadMediaClient> = {}): DownloadMediaClient {
  return { getMessages: vi.fn(async () => undefined), ...overrides };
}

describe('downloadPublicPostMediaWithClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when postId is not a finite number', async () => {
    const client = makeClient();
    expect(
      await downloadPublicPostMediaWithClient(client, ACCOUNT_ID, { handle: '@h', postId: 'x' }),
    ).toBeNull();
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('returns null when the post has no media', async () => {
    const client = makeClient({ getMessages: vi.fn(async () => [{ id: 1317 }]) });
    expect(await downloadPublicPostMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns the photo bytes via getMessages({ids}) + downloadMedia', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const getMessages = vi.fn(async () => [{ id: 1317, media: { _: 'messageMediaPhoto' } }]);
    const downloadMedia = vi.fn(async () => bytes);
    const out = await downloadPublicPostMediaWithClient(
      makeClient({ getMessages, downloadMedia }),
      ACCOUNT_ID,
      OPTS,
    );
    expect(out).toBe(bytes);
    expect(getMessages).toHaveBeenCalledWith('@tomnayaa', { ids: [1317] });
  });

  it('never throws when getMessages rejects', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => {
        throw new Error('CHANNEL_PRIVATE');
      }),
    });
    expect(await downloadPublicPostMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });
});
