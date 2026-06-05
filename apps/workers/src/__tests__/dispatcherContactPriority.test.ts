import { describe, expect, it } from 'vitest';

import {
  dedupeBestContactPerChannel,
  dispatchContactScore,
} from '../queues/campaign-dispatcher.js';

const MANUAL_TAG = 'cmp:camp1';

function contact(over: Partial<{
  id: string;
  channelId: string | null;
  roleGuess: string;
  type: string;
  confidence: number;
  tags: string[];
}> = {}) {
  return {
    id: 'c',
    channelId: 'ch1',
    roleGuess: 'unknown',
    type: 'tg_username',
    confidence: 0.5,
    tags: [] as string[],
    ...over,
  };
}

describe('dispatchContactScore', () => {
  it('ranks ad_manager above owner regardless of confidence', () => {
    const manager = contact({ roleGuess: 'ad_manager', confidence: 0.5 });
    const owner = contact({ roleGuess: 'owner', confidence: 0.99 });
    expect(dispatchContactScore(manager, MANUAL_TAG)).toBeGreaterThan(
      dispatchContactScore(owner, MANUAL_TAG),
    );
  });

  it('lets an operator-tagged contact win over any heuristic role', () => {
    const tagged = contact({ roleGuess: 'owner', tags: [MANUAL_TAG] });
    const manager = contact({ roleGuess: 'ad_manager', tags: [] });
    expect(dispatchContactScore(tagged, MANUAL_TAG)).toBeGreaterThan(
      dispatchContactScore(manager, MANUAL_TAG),
    );
  });
});

describe('dedupeBestContactPerChannel', () => {
  it('keeps the ad_manager and drops the owner on the same channel', () => {
    // Reproduces the bug: owner "По вопросам" has higher confidence and was
    // being messaged instead of the explicit "Сотрудничество: менеджер".
    const owner = contact({
      id: 'rutkismari',
      channelId: 'ch1',
      roleGuess: 'owner',
      confidence: 0.9,
    });
    const manager = contact({
      id: 'leksamng',
      channelId: 'ch1',
      roleGuess: 'ad_manager',
      confidence: 0.6,
    });
    const out = dedupeBestContactPerChannel([owner, manager], MANUAL_TAG);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('leksamng');
  });

  it('keeps one best contact per distinct channel', () => {
    const a1 = contact({ id: 'a1', channelId: 'A', roleGuess: 'owner' });
    const a2 = contact({ id: 'a2', channelId: 'A', roleGuess: 'ad_manager' });
    const b1 = contact({ id: 'b1', channelId: 'B', roleGuess: 'generic' });
    const out = dedupeBestContactPerChannel([a1, a2, b1], MANUAL_TAG);
    expect(out.map((c) => c.id).sort()).toEqual(['a2', 'b1']);
  });

  it('never collapses cold leads (channelId === null)', () => {
    const l1 = contact({ id: 'l1', channelId: null });
    const l2 = contact({ id: 'l2', channelId: null });
    const out = dedupeBestContactPerChannel([l1, l2], MANUAL_TAG);
    expect(out.map((c) => c.id).sort()).toEqual(['l1', 'l2']);
  });
});
