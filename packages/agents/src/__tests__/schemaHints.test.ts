import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { collectEnumHints, renderSchemaHints } from '../schemaHints.js';
import {
  HandoffActionCoerced,
  IntentTargetCoerced,
  IntentTargetEnum,
  LengthCoerced,
} from '../agents/_coerce.js';
import { replyComposerOutputSchema } from '../agents/ReplyComposer.js';
import { handoffDeciderOutputSchema } from '../agents/HandoffDecider.js';

describe('collectEnumHints', () => {
  it('finds a top-level ZodEnum', () => {
    const schema = z.object({ status: z.enum(['ok', 'bad']) });
    const hints = collectEnumHints(schema);
    expect(hints).toEqual([{ path: 'status', allowed: ['ok', 'bad'] }]);
  });

  it('unwraps z.preprocess (legacy coerce shape)', () => {
    // Mimics how older coercers were defined via z.preprocess(fn, enum).
    const wrapped = z.preprocess((v) => v, z.enum(['a', 'b', 'c']));
    const hints = collectEnumHints(z.object({ x: wrapped }));
    expect(hints).toEqual([{ path: 'x', allowed: ['a', 'b', 'c'] }]);
  });

  it('unwraps z.catch (soft-field shape)', () => {
    const wrapped = IntentTargetEnum.catch('answer_question');
    const hints = collectEnumHints(z.object({ intent_target: wrapped }));
    expect(hints[0]?.path).toBe('intent_target');
    expect(hints[0]?.allowed).toContain('confirm_meeting');
    expect(hints[0]?.allowed).toContain('schedule_call');
  });

  it('finds enums inside arrays', () => {
    const schema = z.object({
      variants: z.array(z.object({ intent_target: IntentTargetCoerced })),
    });
    const hints = collectEnumHints(schema);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.path).toBe('variants[].intent_target');
  });

  it('captures discriminated string-literal unions as enum-like', () => {
    const schema = z.object({
      kind: z.union([z.literal('foo'), z.literal('bar')]),
    });
    const hints = collectEnumHints(schema);
    expect(hints).toEqual([{ path: 'kind', allowed: ['foo', 'bar'] }]);
  });

  it('skips fields without a closed vocabulary', () => {
    const schema = z.object({ free: z.string(), n: z.number() });
    const hints = collectEnumHints(schema);
    expect(hints).toEqual([]);
  });

  it('walks real ReplyComposer schema and surfaces intent_target', () => {
    const hints = collectEnumHints(replyComposerOutputSchema);
    const intentHint = hints.find((h) => h.path.endsWith('intent_target'));
    expect(intentHint).toBeDefined();
    expect(intentHint?.allowed).toContain('confirm_meeting');
  });

  it('walks real HandoffDecider schema and surfaces action + urgency', () => {
    const hints = collectEnumHints(handoffDeciderOutputSchema);
    const paths = hints.map((h) => h.path);
    expect(paths).toContain('action');
    expect(paths).toContain('urgency');
    const action = hints.find((h) => h.path === 'action');
    expect(action?.allowed).toEqual(['ai_continue', 'ai_suggest_only', 'operator_now']);
  });

  it('LengthCoerced (preprocess + catch composed) still surfaces buckets', () => {
    const hints = collectEnumHints(z.object({ length: LengthCoerced }));
    expect(hints[0]?.allowed).toEqual(['short', 'medium', 'long']);
  });

  it('HandoffAction (preprocess + enum) surfaces canonical tokens', () => {
    const hints = collectEnumHints(z.object({ action: HandoffActionCoerced }));
    expect(hints[0]?.allowed).toEqual(['ai_continue', 'ai_suggest_only', 'operator_now']);
  });
});

describe('renderSchemaHints', () => {
  it('returns empty string for schemas with no enums', () => {
    expect(renderSchemaHints(z.object({ x: z.string() }))).toBe('');
  });

  it('renders a bullet list of allowed values', () => {
    const out = renderSchemaHints(handoffDeciderOutputSchema);
    expect(out).toContain('action ∈ [ai_continue, ai_suggest_only, operator_now]');
    expect(out).toContain('urgency ∈ [low, normal, high]');
  });
});
