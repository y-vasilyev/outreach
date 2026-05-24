import { describe, expect, it } from 'vitest';

import { ConversationFiltersZ } from '../schemas/conversation.js';

/**
 * `ConversationFiltersZ` is the contract for `GET /conversations` query
 * params. Browsers post empty form fields as the empty string, so the
 * schema must normalise empties before the enum/length validators see
 * them. inbox-campaign-filter change.
 */
describe('ConversationFiltersZ', () => {
  it('treats empty status/mode as absent', () => {
    expect(ConversationFiltersZ.parse({ status: '', mode: '' })).toEqual({
      status: undefined,
      mode: undefined,
      campaignId: undefined,
      assignedOperatorId: undefined,
      q: undefined,
    });
  });

  it('treats whitespace-only status/mode as absent', () => {
    // URL-encoded whitespace (`?status=%20`) should not crash enum
    // validation. Behaviour stays consistent with the trim treatment of
    // campaignId/q.
    expect(ConversationFiltersZ.parse({ status: '  ', mode: '\t' })).toEqual({
      status: undefined,
      mode: undefined,
      campaignId: undefined,
      assignedOperatorId: undefined,
      q: undefined,
    });
  });

  it('matches Cyrillic queries (trimmed, preserved)', () => {
    // Russian-language project: q must pass through non-ASCII unchanged
    // so the downstream ILIKE can find it. Postgres handles ILIKE
    // case-folding via the column collation — locale-dependent, but the
    // schema should not mangle the input.
    expect(ConversationFiltersZ.parse({ q: '  Кофейня  ' }).q).toBe('Кофейня');
  });

  it('treats empty campaignId/assignedOperatorId as absent', () => {
    expect(ConversationFiltersZ.parse({ campaignId: '', assignedOperatorId: '' })).toEqual({
      status: undefined,
      mode: undefined,
      campaignId: undefined,
      assignedOperatorId: undefined,
      q: undefined,
    });
  });

  it('trims and normalises whitespace-only q to undefined', () => {
    expect(ConversationFiltersZ.parse({ q: '   ' }).q).toBeUndefined();
  });

  it('trims q values', () => {
    expect(ConversationFiltersZ.parse({ q: '  acme  ' }).q).toBe('acme');
  });

  it('treats whitespace-only campaignId as undefined', () => {
    expect(ConversationFiltersZ.parse({ campaignId: '   ' }).campaignId).toBeUndefined();
  });

  it('rejects q longer than 200 characters', () => {
    expect(() => ConversationFiltersZ.parse({ q: 'a'.repeat(201) })).toThrow();
  });

  it('accepts q exactly 200 characters', () => {
    const q = 'a'.repeat(200);
    expect(ConversationFiltersZ.parse({ q }).q).toBe(q);
  });

  it('passes valid status + mode through', () => {
    expect(
      ConversationFiltersZ.parse({ status: 'active', mode: 'manual' }),
    ).toEqual({
      status: 'active',
      mode: 'manual',
      campaignId: undefined,
      assignedOperatorId: undefined,
      q: undefined,
    });
  });

  it('still rejects unknown enum values', () => {
    expect(() => ConversationFiltersZ.parse({ status: 'bogus' })).toThrow();
  });

  it('returns empty filters for empty input', () => {
    expect(ConversationFiltersZ.parse({})).toEqual({
      status: undefined,
      mode: undefined,
      campaignId: undefined,
      assignedOperatorId: undefined,
      q: undefined,
    });
  });
});
