import { describe, expect, it } from 'vitest';

import { appendQuery } from '../api';

/**
 * `appendQuery` is a small helper that lets `api.get(path, { params })`
 * forward filter objects without callers having to filter empty values
 * themselves. inbox-campaign-filter change.
 */
describe('appendQuery', () => {
  it('returns the path unchanged when params is undefined', () => {
    expect(appendQuery('/foo')).toBe('/foo');
  });

  it('returns the path unchanged when params is empty', () => {
    expect(appendQuery('/foo', {})).toBe('/foo');
  });

  it('appends a single non-empty value', () => {
    expect(appendQuery('/foo', { a: 'x' })).toBe('/foo?a=x');
  });

  it('drops keys with undefined / null / empty-string values', () => {
    expect(
      appendQuery('/foo', { a: 'x', b: undefined, c: null, d: '' }),
    ).toBe('/foo?a=x');
  });

  it('serialises multiple values', () => {
    const got = appendQuery('/foo', { a: '1', b: '2' });
    // URLSearchParams does not guarantee order across runtimes — assert
    // both orderings are acceptable.
    expect(['/foo?a=1&b=2', '/foo?b=2&a=1']).toContain(got);
  });

  it('preserves an existing query string in the path', () => {
    expect(appendQuery('/foo?keep=1', { a: 'x' })).toBe('/foo?keep=1&a=x');
  });

  it('URL-encodes special characters', () => {
    expect(appendQuery('/foo', { q: 'a b/c' })).toBe('/foo?q=a+b%2Fc');
  });

  it('stringifies non-string primitives', () => {
    expect(appendQuery('/foo', { n: 42, b: true })).toContain('n=42');
    expect(appendQuery('/foo', { n: 42, b: true })).toContain('b=true');
  });

  it('does not emit ? when all values are dropped', () => {
    expect(appendQuery('/foo', { a: undefined, b: '' })).toBe('/foo');
  });
});
