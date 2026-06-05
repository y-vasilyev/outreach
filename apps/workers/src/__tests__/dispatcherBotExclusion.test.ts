import { describe, expect, it } from 'vitest';

import { AUTO_DISPATCH_BASE_WHERE } from '../queues/campaign-dispatcher.js';

describe('campaign dispatcher — bot exclusion', () => {
  it('only selects TG-reachable contacts', () => {
    expect(AUTO_DISPATCH_BASE_WHERE.reachability).toBe('reachable_tg');
  });

  it('excludes type=bot from auto-dispatch even though bots are reachable_tg', () => {
    expect(AUTO_DISPATCH_BASE_WHERE.type).toEqual({ not: 'bot' });
  });
});
