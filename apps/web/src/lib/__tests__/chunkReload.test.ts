import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('chunk reload recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    sessionStorage.clear();
  });

  it('reloads once and keeps the sentinel until a successful navigation clears it', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const { recoverFromChunkError } = await import('../chunkReload');

    recoverFromChunkError();
    recoverFromChunkError();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('reloadedForChunkError')).toBe('1');
  });

  it('allows a future recovery after the sentinel is explicitly cleared', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const { clearChunkReloadSentinel, recoverFromChunkError } = await import('../chunkReload');

    recoverFromChunkError();
    clearChunkReloadSentinel();
    vi.resetModules();
    const fresh = await import('../chunkReload');
    fresh.recoverFromChunkError();

    expect(reload).toHaveBeenCalledTimes(2);
  });
});
