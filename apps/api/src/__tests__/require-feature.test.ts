import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * requireFeature preHandler (runtime-feature-flags M2): routes are registered
 * unconditionally and this gate 404s when the flag is off, using the SAME
 * plain 404 (`reply.callNotFound()`) an unregistered route would produce — so
 * the web's feature-off detection keeps working — and flipping the flag
 * changes availability with no restart (same accessor instance, no re-import).
 */

const mocks = vi.hoisted(() => {
  const flagState: Record<string, boolean> = {};
  return { flagState };
});

vi.mock('../feature-flags.js', () => ({
  getFeatureFlags: () => ({ get: (k: string) => mocks.flagState[k] ?? false }),
}));

import { requireFeature } from '../require-feature.js';

function fakeReply() {
  return { callNotFound: vi.fn() };
}

afterEach(() => {
  mocks.flagState.campaign_types = false;
});

describe('requireFeature', () => {
  it('404s (callNotFound) when the flag is off', async () => {
    const reply = fakeReply();
    await requireFeature('campaign_types')({} as never, reply as never);
    expect(reply.callNotFound).toHaveBeenCalledTimes(1);
  });

  it('passes through (no 404) once the flag is enabled — no restart', async () => {
    const gate = requireFeature('campaign_types');

    const off = fakeReply();
    await gate({} as never, off as never);
    expect(off.callNotFound).toHaveBeenCalledTimes(1);

    // Enable at runtime; the very same preHandler instance now lets requests through.
    mocks.flagState.campaign_types = true;
    const on = fakeReply();
    await gate({} as never, on as never);
    expect(on.callNotFound).not.toHaveBeenCalled();
  });
});
