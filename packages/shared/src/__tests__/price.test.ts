import { describe, it, expect } from 'vitest';
import { normalizePriceToken } from '../price.js';

describe('normalizePriceToken (harden-reply-extraction)', () => {
  it('parses plain and space-separated numbers', () => {
    expect(normalizePriceToken('118000')).toBe(118000);
    expect(normalizePriceToken('118 000')).toBe(118000);
    expect(normalizePriceToken('118 000')).toBe(118000); // NBSP
    expect(normalizePriceToken('1 200 000')).toBe(1200000); // thin space
  });

  it('strips approximation / "от" prefixes', () => {
    expect(normalizePriceToken('от 118000')).toBe(118000);
    expect(normalizePriceToken('от 118 000')).toBe(118000);
    expect(normalizePriceToken('~50000')).toBe(50000);
    expect(normalizePriceToken('около 50 000')).toBe(50000);
  });

  it('applies к / тыс multipliers', () => {
    expect(normalizePriceToken('50к')).toBe(50000);
    expect(normalizePriceToken('50k')).toBe(50000);
    expect(normalizePriceToken('15 тыс')).toBe(15000);
    expect(normalizePriceToken('15тыс.')).toBe(15000);
    expect(normalizePriceToken('1.5к')).toBe(1500);
  });

  it('applies млн / млрд multipliers (the new case)', () => {
    expect(normalizePriceToken('1.2млн')).toBe(1200000);
    expect(normalizePriceToken('1,2 млн')).toBe(1200000);
    expect(normalizePriceToken('1 млн')).toBe(1000000);
    expect(normalizePriceToken('2 миллиона')).toBe(2000000);
    expect(normalizePriceToken('1.5 млрд')).toBe(1500000000);
  });

  it('returns null (not 0) for non-prices', () => {
    expect(normalizePriceToken('договорная')).toBeNull();
    expect(normalizePriceToken('')).toBeNull();
    expect(normalizePriceToken('абв')).toBeNull();
    // a bare unit with no number is not a price
    expect(normalizePriceToken('млн')).toBeNull();
  });
});
