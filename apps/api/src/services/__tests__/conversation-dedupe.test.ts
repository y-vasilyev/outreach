import { describe, expect, it } from 'vitest';

import { planConversationDedupe, type DedupeCandidate } from '../conversation-dedupe.js';

function conv(over: Partial<DedupeCandidate> = {}): DedupeCandidate {
  return {
    id: 'c',
    channelId: 'ch1',
    hasMessages: false,
    roleGuess: 'unknown',
    type: 'tg_username',
    confidence: 0.5,
    createdAtMs: 1_000,
    ...over,
  };
}

describe('planConversationDedupe', () => {
  it('keeps the chat we already wrote to and removes the empty duplicate', () => {
    // Core requirement: «если я уже кому-то написал, оставляем этот чат».
    const written = conv({ id: 'written', hasMessages: true, roleGuess: 'owner' });
    const empty = conv({ id: 'empty', hasMessages: false, roleGuess: 'ad_manager' });
    const remove = planConversationDedupe([written, empty]);
    expect(remove).toEqual(['empty']);
  });

  it('keeps EVERY engaged thread on a channel, drops only empty shells', () => {
    const a = conv({ id: 'a', hasMessages: true });
    const b = conv({ id: 'b', hasMessages: true });
    const shell = conv({ id: 'shell', hasMessages: false });
    const remove = planConversationDedupe([a, b, shell]);
    expect(remove).toEqual(['shell']);
  });

  it('when nothing was sent yet, keeps the best contact (ad_manager) and removes the rest', () => {
    const owner = conv({ id: 'owner', roleGuess: 'owner', confidence: 0.9 });
    const manager = conv({ id: 'manager', roleGuess: 'ad_manager', confidence: 0.6 });
    const remove = planConversationDedupe([owner, manager]);
    expect(remove).toEqual(['owner']);
  });

  it('breaks an all-empty equal-priority tie by keeping the oldest', () => {
    const older = conv({ id: 'older', createdAtMs: 100 });
    const newer = conv({ id: 'newer', createdAtMs: 200 });
    const remove = planConversationDedupe([newer, older]);
    expect(remove).toEqual(['newer']);
  });

  it('never touches a channel that has a single conversation', () => {
    expect(planConversationDedupe([conv({ id: 'solo' })])).toEqual([]);
  });

  it('dedupes each channel independently', () => {
    const rows = [
      conv({ id: 'a1', channelId: 'A', roleGuess: 'owner' }),
      conv({ id: 'a2', channelId: 'A', roleGuess: 'ad_manager' }),
      conv({ id: 'b1', channelId: 'B', hasMessages: true }),
      conv({ id: 'b2', channelId: 'B', hasMessages: false }),
    ];
    expect(planConversationDedupe(rows).sort()).toEqual(['a1', 'b2']);
  });

  it('never removes cold-lead conversations (no channel)', () => {
    const l1 = conv({ id: 'l1', channelId: null });
    const l2 = conv({ id: 'l2', channelId: null });
    expect(planConversationDedupe([l1, l2])).toEqual([]);
  });
});
