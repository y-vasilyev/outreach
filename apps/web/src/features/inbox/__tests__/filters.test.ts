import { describe, expect, it } from 'vitest';

import { hasAnyFilter, mergeFilterQuery, parseInboxFilters } from '../filters';

/**
 * Pure helper for the inbox URL state. Verifies the whitelist of keys,
 * enum validation, and the merge semantics that the InboxPage uses to
 * push patches into `route.query`. inbox-campaign-filter change.
 */
describe('parseInboxFilters', () => {
  it('extracts the whitelisted keys and ignores unknown ones', () => {
    const got = parseInboxFilters({
      campaignId: 'c1',
      status: 'active',
      mode: 'manual',
      assignedOperatorId: 'op-1',
      q: 'acme',
      somethingElse: 'leak',
    });
    expect(got).toEqual({
      campaignId: 'c1',
      status: 'active',
      mode: 'manual',
      assignedOperatorId: 'op-1',
      q: 'acme',
    });
  });

  it('drops malformed enum values instead of leaking garbage to the API', () => {
    const got = parseInboxFilters({ status: 'bogus', mode: 'maybe' });
    expect(got.status).toBeUndefined();
    expect(got.mode).toBeUndefined();
  });

  it('trims string values and treats whitespace-only as absent', () => {
    expect(parseInboxFilters({ q: '   ' }).q).toBeUndefined();
    expect(parseInboxFilters({ q: '  acme  ' }).q).toBe('acme');
    expect(parseInboxFilters({ campaignId: '' }).campaignId).toBeUndefined();
  });

  it('drops array-valued query params (Vue Router may produce arrays)', () => {
    const got = parseInboxFilters({ campaignId: ['c1', 'c2'] as unknown as string });
    expect(got.campaignId).toBeUndefined();
  });
});

describe('mergeFilterQuery', () => {
  it('removes keys whose patch value is undefined', () => {
    expect(mergeFilterQuery({ campaignId: 'c1', q: 'acme' }, { campaignId: undefined })).toEqual({
      q: 'acme',
    });
  });

  it('removes keys whose patch value is empty / whitespace-only', () => {
    expect(mergeFilterQuery({ q: 'acme' }, { q: '   ' })).toEqual({});
    expect(mergeFilterQuery({ q: 'acme' }, { q: '' })).toEqual({});
  });

  it('preserves keys not present in the patch (such as assignedOperatorId)', () => {
    expect(
      mergeFilterQuery(
        { campaignId: 'c1', assignedOperatorId: 'op-1' },
        { campaignId: undefined },
      ),
    ).toEqual({ assignedOperatorId: 'op-1' });
  });

  it('trims string values it sets', () => {
    expect(mergeFilterQuery({}, { q: '  acme  ' })).toEqual({ q: 'acme' });
  });

  it('does not propagate array query values into the merged record', () => {
    expect(
      mergeFilterQuery({ campaignId: ['c1', 'c2'] as unknown as string }, { q: 'acme' }),
    ).toEqual({ q: 'acme' });
  });
});

describe('hasAnyFilter', () => {
  it('returns false for an empty filter object', () => {
    expect(hasAnyFilter({})).toBe(false);
  });

  it('returns true when any single filter is set', () => {
    expect(hasAnyFilter({ campaignId: 'c1' })).toBe(true);
    expect(hasAnyFilter({ q: 'acme' })).toBe(true);
    expect(hasAnyFilter({ assignedOperatorId: 'op-1' })).toBe(true);
  });
});
