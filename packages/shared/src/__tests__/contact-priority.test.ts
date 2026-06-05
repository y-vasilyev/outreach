import { describe, expect, it } from 'vitest';

import { scoreContactPriority } from '../contact-priority.js';

describe('scoreContactPriority', () => {
  it('ranks ad_manager above owner regardless of confidence', () => {
    // The reported bug: a high-confidence owner («По вопросам») outscored the
    // explicit ad_manager («Сотрудничество: менеджер»). Role must dominate.
    const manager = scoreContactPriority({
      roleGuess: 'ad_manager',
      type: 'tg_username',
      confidence: 0.5,
    });
    const owner = scoreContactPriority({
      roleGuess: 'owner',
      type: 'tg_username',
      confidence: 0.99,
    });
    expect(manager).toBeGreaterThan(owner);
  });

  it('orders roles ad_manager > owner > generic > bot > unknown', () => {
    const score = (roleGuess: string) =>
      scoreContactPriority({ roleGuess, type: 'tg_username', confidence: 0.5 });
    expect(score('ad_manager')).toBeGreaterThan(score('owner'));
    expect(score('owner')).toBeGreaterThan(score('generic'));
    expect(score('generic')).toBeGreaterThan(score('bot'));
    expect(score('bot')).toBeGreaterThan(score('unknown'));
  });

  it('breaks role ties by contact type then confidence', () => {
    const username = scoreContactPriority({
      roleGuess: 'ad_manager',
      type: 'tg_username',
      confidence: 0.5,
    });
    const email = scoreContactPriority({
      roleGuess: 'ad_manager',
      type: 'email',
      confidence: 0.5,
    });
    expect(username).toBeGreaterThan(email);

    const hi = scoreContactPriority({ roleGuess: 'owner', type: 'email', confidence: 0.9 });
    const lo = scoreContactPriority({ roleGuess: 'owner', type: 'email', confidence: 0.1 });
    expect(hi).toBeGreaterThan(lo);
  });

  it('coerces a missing/odd confidence to 0 without throwing', () => {
    expect(() =>
      scoreContactPriority({ roleGuess: 'unknown', type: 'other', confidence: undefined }),
    ).not.toThrow();
  });
});
