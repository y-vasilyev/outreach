import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadInboundMediaWithClient,
  type DownloadMediaClient,
} from '../SessionManager.js';

/**
 * Unit tests for the pure helper that backs `handle.downloadInboundMedia`.
 * Each test exercises one branch of the contract — every failure mode MUST
 * resolve to `null` (never throw) so the tg-listen worker can write an
 * honest-pending `media_asset` row instead of crashing the inbound path.
 * See openspec change `verify-download-inbound-media`.
 */

const ACCOUNT_ID = 'parser-default';
const OPTS = { peerKey: 'tg:user:999000111', tgMsgId: '42' };

function makeClient(overrides: Partial<DownloadMediaClient> = {}): DownloadMediaClient {
  return {
    getMessages: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('downloadInboundMediaWithClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when tgMsgId is not a finite number', async () => {
    const client = makeClient();
    const out = await downloadInboundMediaWithClient(client, ACCOUNT_ID, {
      peerKey: OPTS.peerKey,
      tgMsgId: 'not-a-number',
    });
    expect(out).toBeNull();
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it('returns null when getMessages resolves to undefined', async () => {
    const client = makeClient({ getMessages: vi.fn(async () => undefined) });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns null when getMessages returns an empty array', async () => {
    const client = makeClient({ getMessages: vi.fn(async () => []) });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns null when the fetched message has no media', async () => {
    const client = makeClient({ getMessages: vi.fn(async () => [{ id: 42 }]) });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns null when downloadMedia is not a function on the client', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaPhoto' } }]),
      // no downloadMedia — older GramJS builds expose it on the prototype only
    });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns null and logs a warning when downloadMedia throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaDocument' } }]),
      downloadMedia: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('downloadInboundMedia failed');
  });

  it('returns null when downloadMedia resolves to null', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaPhoto' } }]),
      downloadMedia: vi.fn(async () => null),
    });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('returns Uint8Array bytes when downloadMedia resolves to Uint8Array', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaPhoto' } }]),
      downloadMedia: vi.fn(async () => buf),
    });
    const out = await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS);
    expect(out).toBe(buf);
  });

  it('UTF-8 encodes when downloadMedia resolves to a string', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaDocument' } }]),
      downloadMedia: vi.fn(async () => 'привет'),
    });
    const out = await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out!)).toBe('привет');
  });

  it('treats Node Buffer (Uint8Array subclass) as bytes and returns as-is', async () => {
    const buf = Buffer.from([10, 20, 30]);
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaPhoto' } }]),
      downloadMedia: vi.fn(async () => buf),
    });
    const out = await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out!)).toEqual([10, 20, 30]);
  });

  it('returns null when downloadMedia resolves to an unsupported type (object, number, etc.)', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => [{ media: { _: 'MessageMediaDocument' } }]),
      downloadMedia: vi.fn(async () => ({ not: 'bytes' })),
    });
    expect(await downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS)).toBeNull();
  });

  it('forwards the correct shape to getMessages (peerKey + ids array)', async () => {
    const getMessages = vi.fn(async () => undefined);
    await downloadInboundMediaWithClient(makeClient({ getMessages }), ACCOUNT_ID, OPTS);
    expect(getMessages).toHaveBeenCalledWith('tg:user:999000111', { ids: [42] });
  });

  it('never throws even when getMessages itself throws', async () => {
    const client = makeClient({
      getMessages: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    await expect(
      downloadInboundMediaWithClient(client, ACCOUNT_ID, OPTS),
    ).resolves.toBeNull();
  });
});
