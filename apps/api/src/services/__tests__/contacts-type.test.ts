import { describe, expect, it } from 'vitest';

import {
  detectContactType,
  normalizeContactValue,
  reachabilityForType,
} from '../contacts.js';

describe('detectContactType — bot', () => {
  it('detects a bare @<handle>_bot as bot', () => {
    expect(detectContactType('@hadeout_bot')).toBe('bot');
  });

  it('detects a t.me/<handle>_bot link as bot', () => {
    expect(detectContactType('t.me/hadeout_bot')).toBe('bot');
    expect(detectContactType('https://t.me/hadeout_bot')).toBe('bot');
  });

  it('detects a handle ending in plain "bot" as bot', () => {
    expect(detectContactType('@channelbot')).toBe('bot');
  });

  it('keeps a normal username as tg_username', () => {
    expect(detectContactType('@hadeout_ads')).toBe('tg_username');
    expect(detectContactType('t.me/hadeout_ads')).toBe('tg_username');
  });

  it('still detects email / phone / website', () => {
    expect(detectContactType('ads@brand.io')).toBe('email');
    expect(detectContactType('+7 495 555-22-33')).toBe('tg_phone');
    expect(detectContactType('https://brand.io')).toBe('website');
  });
});

describe('normalizeContactValue — bot', () => {
  it('strips @, scheme and t.me/ to a bare lowercase handle', () => {
    expect(normalizeContactValue('bot', '@Hadeout_Bot')).toBe('hadeout_bot');
    expect(normalizeContactValue('bot', 't.me/Hadeout_Bot')).toBe('hadeout_bot');
    expect(normalizeContactValue('bot', 'https://t.me/hadeout_bot')).toBe('hadeout_bot');
    expect(normalizeContactValue('bot', 'hadeout_bot')).toBe('hadeout_bot');
  });
});

describe('reachabilityForType — bot', () => {
  it('treats bot as reachable_tg', () => {
    expect(reachabilityForType('bot')).toBe('reachable_tg');
  });

  it('keeps the existing mapping for other types', () => {
    expect(reachabilityForType('tg_username')).toBe('reachable_tg');
    expect(reachabilityForType('email')).toBe('manual');
    expect(reachabilityForType('other')).toBe('unreachable');
  });
});
