import { describe, expect, it, vi } from 'vitest';

import { renderTemplate } from '../promptRender.js';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    expect(renderTemplate('Hello, {{name}}!', { name: 'world' })).toBe(
      'Hello, world!',
    );
  });

  it('is whitespace tolerant', () => {
    expect(renderTemplate('{{  name }} / {{name  }} / {{ name }}', { name: 'x' })).toBe(
      'x / x / x',
    );
  });

  it('substitutes empty string for unknown vars and logs debug', () => {
    const debug = vi.fn();
    const out = renderTemplate('a={{a}} b={{b}}', { a: '1' }, { debug });
    expect(out).toBe('a=1 b=');
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('stringifies numbers/booleans', () => {
    expect(renderTemplate('{{n}} {{f}}', { n: 42, f: false })).toBe('42 false');
  });

  it('stringifies arrays and objects via JSON.stringify', () => {
    expect(renderTemplate('arr={{a}} obj={{o}}', { a: [1, 2], o: { x: 1 } })).toBe(
      'arr=[1,2] obj={"x":1}',
    );
  });

  it('renders null/undefined as empty', () => {
    expect(renderTemplate('{{a}}/{{b}}', { a: null, b: undefined })).toBe('/');
  });

  it('returns empty for empty template', () => {
    expect(renderTemplate('', { a: 1 })).toBe('');
  });

  it('does not match malformed placeholders', () => {
    expect(renderTemplate('{ {a}} { not a var }', { a: 'x' })).toBe(
      '{ {a}} { not a var }',
    );
  });
});
