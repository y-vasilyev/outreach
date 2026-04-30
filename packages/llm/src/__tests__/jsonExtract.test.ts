import { describe, expect, it } from 'vitest';

import { extractJson, parseJsonStrict } from '../providers/jsonExtract.js';

describe('extractJson', () => {
  it('extracts a plain JSON object', () => {
    const out = extractJson('{"a":1,"b":2}');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it('strips ```json``` markdown fences', () => {
    const text = '```json\n{"hello":"world"}\n```';
    expect(JSON.parse(extractJson(text))).toEqual({ hello: 'world' });
  });

  it('strips bare ``` fences with no language tag', () => {
    const text = '```\n{"x":42}\n```';
    expect(JSON.parse(extractJson(text))).toEqual({ x: 42 });
  });

  it('handles garbage prefix and suffix prose', () => {
    const text = 'Sure! Here you go:\n{"ok":true}\nLet me know if you need more.';
    expect(JSON.parse(extractJson(text))).toEqual({ ok: true });
  });

  it('handles braces inside string literals (balanced)', () => {
    const text = '{"msg":"this has { and } inside","n":1}';
    expect(JSON.parse(extractJson(text))).toEqual({
      msg: 'this has { and } inside',
      n: 1,
    });
  });

  it('handles nested objects (balanced braces)', () => {
    const text = 'noise {"a":{"b":{"c":1}},"d":2} trailing noise';
    expect(JSON.parse(extractJson(text))).toEqual({
      a: { b: { c: 1 } },
      d: 2,
    });
  });

  it('handles top-level arrays', () => {
    const text = '```json\n[1, 2, {"k":"v"}]\n```';
    expect(JSON.parse(extractJson(text))).toEqual([1, 2, { k: 'v' }]);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"q":"he said \\"hi\\" } { still string"}';
    expect(JSON.parse(extractJson(text))).toEqual({
      q: 'he said "hi" } { still string',
    });
  });

  it('throws when no JSON is present', () => {
    expect(() => extractJson('just text, sorry')).toThrow();
  });

  it('throws when braces are unbalanced', () => {
    expect(() => extractJson('{"a":1, "b": ')).toThrow();
  });
});

describe('parseJsonStrict', () => {
  it('parses and validates via parser callback', () => {
    const out = parseJsonStrict('```json\n{"n": 5}\n```', (v) => {
      const obj = v as { n: unknown };
      if (typeof obj.n !== 'number') throw new Error('n must be number');
      return { n: obj.n };
    });
    expect(out).toEqual({ n: 5 });
  });

  it('throws upstream error when parser rejects', () => {
    expect(() =>
      parseJsonStrict('{"n":"oops"}', (v) => {
        const obj = v as { n: unknown };
        if (typeof obj.n !== 'number') throw new Error('n must be number');
        return obj;
      }),
    ).toThrow(/JSON failed validation/);
  });

  it('throws upstream error on invalid JSON', () => {
    expect(() => parseJsonStrict('{not json}', (v) => v)).toThrow(/invalid JSON/);
  });
});
