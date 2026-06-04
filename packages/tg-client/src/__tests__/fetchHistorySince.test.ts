import { describe, expect, it, vi } from 'vitest';
import { fetchHistorySinceImpl } from '../methods/fetchHistorySince.js';

describe('fetchHistorySinceImpl', () => {
  it('keeps media-only private history rows so sync can surface placeholders', async () => {
    const client = {
      getMessages: vi.fn().mockResolvedValue([
        {
          id: 42,
          message: '',
          out: false,
          date: 1_780_000_000,
          peerId: { className: 'PeerUser', userId: { toString: () => '999' } },
          senderId: { toString: () => '999' },
          media: {
            className: 'MessageMediaDocument',
            document: {
              mimeType: 'application/pdf',
              size: 12345,
              attributes: [{ className: 'DocumentAttributeFilename', fileName: 'media-kit.pdf' }],
            },
          },
        },
      ]),
    };

    const rows = await fetchHistorySinceImpl(client, {
      tgAccountId: 'tg1',
      peerKey: '@contact',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        text: '',
        tgMsgId: '42',
        fromTgUserId: '999',
        media: {
          className: 'MessageMediaDocument',
          kind: 'document',
          mime: 'application/pdf',
          bytes: 12345,
          fileName: 'media-kit.pdf',
        },
      }),
    ]);
  });
});
