import { describe, expect, it } from 'vitest';
import { mediaAssetKey, rawPayloadKey, buildRawPayloadSnapshot } from '../index.js';

describe('mediaAssetKey', () => {
  it('namespaces by profile when known', () => {
    expect(mediaAssetKey({ profileId: 'p1', assetId: 'a1' })).toBe('bloggers/p1/a1');
  });
  it('falls back to conversation scope when no profile', () => {
    expect(mediaAssetKey({ conversationId: 'c1', assetId: 'a1' })).toBe(
      'conversations/c1/a1',
    );
  });
  it('falls back to unscoped when neither is present', () => {
    expect(mediaAssetKey({ assetId: 'a1' })).toBe('unscoped/a1');
  });
});

describe('rawPayloadKey', () => {
  it('is deterministic per source message', () => {
    const k1 = rawPayloadKey({ conversationId: 'c1', sourceMessageId: 'm1' });
    const k2 = rawPayloadKey({ conversationId: 'c1', sourceMessageId: 'm1' });
    expect(k1).toBe(k2);
    expect(k1).toBe('raw-payloads/c1/m1.json');
  });
  it('namespaces under the profile when known (N1), still ending in sourceMessageId', () => {
    expect(
      rawPayloadKey({ conversationId: 'c1', sourceMessageId: 'm1', profileId: 'p1' }),
    ).toBe('bloggers/p1/raw-payloads/m1.json');
  });
});

describe('buildRawPayloadSnapshot', () => {
  it('preserves verbatim raw text and parsed JSON', () => {
    const body = buildRawPayloadSnapshot({
      conversationId: 'c1',
      sourceMessageId: 'm1',
      rawText: '  exact  text  ',
      parsed: { reach: 1000 },
    });
    const parsed = JSON.parse(body) as {
      rawText: string;
      parsed: { reach: number };
      conversationId: string;
    };
    expect(parsed.rawText).toBe('  exact  text  ');
    expect(parsed.parsed.reach).toBe(1000);
    expect(parsed.conversationId).toBe('c1');
  });
});
