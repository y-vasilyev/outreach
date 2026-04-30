import { describe, expect, it } from 'vitest';

import {
  emailRegex,
  phoneRegex,
  runRegexCandidates,
  tgLinkRegex,
  tgUsernameRegex,
  urlRegex,
} from '../regex.js';

function freshAll(re: RegExp, text: string): RegExpMatchArray[] {
  return Array.from(text.matchAll(new RegExp(re.source, re.flags)));
}

describe('tgUsernameRegex', () => {
  it('captures bare @handles after whitespace', () => {
    const matches = freshAll(tgUsernameRegex, 'write to @vasya_001 about ads');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[1]).toBe('vasya_001');
  });

  it('captures @handle at start of string', () => {
    const matches = freshAll(tgUsernameRegex, '@startuser is the owner');
    expect(matches[0]?.[1]).toBe('startuser');
  });

  it('rejects too-short handles', () => {
    expect(freshAll(tgUsernameRegex, 'see @abc here')).toHaveLength(0);
  });

  it('does not capture inside email addresses', () => {
    const matches = freshAll(tgUsernameRegex, 'foo@example.com');
    expect(matches).toHaveLength(0);
  });
});

describe('tgLinkRegex', () => {
  it('captures t.me/<handle>', () => {
    const m = freshAll(tgLinkRegex, 'check https://t.me/somechannel today');
    expect(m).toHaveLength(1);
    expect(m[0]?.[1]).toBe('somechannel');
  });

  it('captures bare t.me/<handle>', () => {
    const m = freshAll(tgLinkRegex, 't.me/another_one');
    expect(m).toHaveLength(1);
    expect(m[0]?.[1]).toBe('another_one');
  });
});

describe('emailRegex', () => {
  it('captures emails', () => {
    const m = freshAll(emailRegex, 'reach me at hello@nosquare.io please');
    expect(m).toHaveLength(1);
    expect(m[0]?.[0]).toBe('hello@nosquare.io');
  });

  it('captures multiple emails', () => {
    const m = freshAll(emailRegex, 'a@b.io and c@d.co');
    expect(m).toHaveLength(2);
  });
});

describe('phoneRegex', () => {
  it('captures international phones', () => {
    const m = freshAll(phoneRegex, 'call +1 555 123 4567 today');
    expect(m.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects short numeric strings (< 7 digits)', () => {
    // The regex itself can match, but the helper applies digit-count threshold.
    const candidates = runRegexCandidates('order #1234 ready');
    expect(candidates.find((c) => c.type === 'phone')).toBeUndefined();
  });
});

describe('urlRegex', () => {
  it('captures http(s) URLs', () => {
    const m = freshAll(urlRegex, 'visit https://example.com/path?x=1 and http://a.io');
    expect(m).toHaveLength(2);
  });
});

describe('runRegexCandidates', () => {
  it('emits all detected types and dedupes', () => {
    const text = `Bio: contact @vasya_001 or t.me/vasya_001 for details.
Email: ads@vasya.io. Phone +7 (495) 555-22-33. Site https://vasya.io.`;

    const cands = runRegexCandidates(text);
    const types = cands.map((c) => c.type);

    expect(types).toContain('tg_username');
    expect(types).toContain('tg_link');
    expect(types).toContain('email');
    expect(types).toContain('phone');
    expect(types).toContain('website');

    // Each candidate has a contextual snippet.
    for (const c of cands) {
      expect(c.context_snippet.length).toBeGreaterThan(0);
    }
  });

  it('dedupes same (type, value) pairs', () => {
    const text = '@vasya_001 ... again @vasya_001';
    const cands = runRegexCandidates(text);
    const tg = cands.filter((c) => c.type === 'tg_username');
    expect(tg).toHaveLength(1);
  });

  it('does not double-count t.me URL as both website and tg_link', () => {
    const cands = runRegexCandidates('see https://t.me/foo_bar today');
    const types = cands.map((c) => c.type);
    expect(types).toContain('tg_link');
    expect(types).not.toContain('website');
  });

  it('returns empty for empty input', () => {
    expect(runRegexCandidates('')).toEqual([]);
  });
});
