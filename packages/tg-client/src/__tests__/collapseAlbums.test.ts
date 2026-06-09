import { describe, expect, it } from 'vitest';

import { collapseAlbums } from '../SessionManager.js';

/**
 * Telegram albums (grouped media) arrive as N separate messages sharing a
 * `groupedId`: only one carries the caption, the metrics are duplicated across
 * members. `collapseAlbums` folds each album into ONE RecentPost so the
 * catalog's "top posts" shows one card per post (not one per photo) and keeps
 * the root caption. Mirrors the real bug: https://t.me/polyaam/25518.
 */

// GramJS-shaped message. getMessages returns newest-first (descending id).
function msg(
  id: number,
  opts: { groupedId?: number; message?: string; views?: number; reactions?: unknown } = {},
): Record<string, unknown> {
  return {
    id,
    date: 1_700_000_000,
    message: opts.message ?? '',
    ...(opts.groupedId !== undefined && { groupedId: opts.groupedId }),
    ...(opts.views !== undefined && { views: opts.views }),
    ...(opts.reactions !== undefined && { reactions: opts.reactions }),
  };
}

describe('collapseAlbums', () => {
  it('folds an album (shared groupedId) into a single post', () => {
    // Newest-first: 25520 (no caption) … 25518 (caption, smallest id).
    const out = collapseAlbums([
      msg(25520, { groupedId: 99, views: 1000 }),
      msg(25519, { groupedId: 99, views: 1000 }),
      msg(25518, { groupedId: 99, message: 'подпись альбома', views: 1000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(25518); // album anchor = smallest id
    expect(out[0]!.text).toBe('подпись альбома'); // root caption preserved
    expect(out[0]!.metrics?.views).toBe(1000); // not summed across photos
  });

  it('keeps separate (non-album) posts untouched', () => {
    const out = collapseAlbums([
      msg(10, { message: 'a', views: 5 }),
      msg(9, { message: 'b', views: 6 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.id)).toEqual([10, 9]);
  });

  it('takes the max metric across album members (counts may sit on one member)', () => {
    const out = collapseAlbums([
      msg(2, { groupedId: 7, reactions: { results: [{ count: 12 }] } }),
      msg(1, { groupedId: 7, message: 'cap' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics?.reactions).toBe(12);
    expect(out[0]!.text).toBe('cap');
  });

  it('treats two distinct albums and a single post as three posts', () => {
    const out = collapseAlbums([
      msg(5, { groupedId: 1, message: 'album one' }),
      msg(4, { groupedId: 1 }),
      msg(3, { message: 'lone post' }),
      msg(2, { groupedId: 2, message: 'album two' }),
      msg(1, { groupedId: 2 }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.id)).toEqual([4, 3, 1]);
  });
});
