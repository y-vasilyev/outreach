import { describe, it, expect } from 'vitest';
import {
  OperatorDataPointWriteZ,
  coerceOperatorValue,
  isOperatorEditableField,
  ExtractionHintInputZ,
  hintsToOperatorStrings,
  ReanalyzeRequestZ,
} from '../schemas/operator-markup.js';

describe('operator data-point write (field-aware)', () => {
  it('accepts and coerces numeric fields incl. price strings', () => {
    expect(coerceOperatorValue('reach', 50000)).toBe(50000);
    expect(coerceOperatorValue('reach', '50к')).toBe(50000);
    expect(coerceOperatorValue('rate.post', '1.2млн')).toBe(1200000);
    expect(OperatorDataPointWriteZ.safeParse({ field: 'reach', value: '50к' }).success).toBe(true);
  });

  it('accepts audience share records', () => {
    expect(coerceOperatorValue('audience.geo', { 'Россия': 0.7, 'Казахстан': 0.3 })).toBeTruthy();
    expect(coerceOperatorValue('audience.geo', { 'Россия': 'много' })).toBeUndefined();
  });

  it('rejects non-editable fields and bad values', () => {
    expect(isOperatorEditableField('topics')).toBe(false);
    expect(OperatorDataPointWriteZ.safeParse({ field: 'topics', value: ['x'] }).success).toBe(false);
    expect(OperatorDataPointWriteZ.safeParse({ field: 'reach', value: 'договорная' }).success).toBe(false);
  });
});

describe('extraction hint schema', () => {
  it('channel scope requires channelId; conversation requires conversationId', () => {
    expect(ExtractionHintInputZ.safeParse({ scope: 'channel', guidance: 'x' }).success).toBe(false);
    expect(ExtractionHintInputZ.safeParse({ scope: 'channel', channelId: 'c1', guidance: 'x' }).success).toBe(true);
    expect(ExtractionHintInputZ.safeParse({ scope: 'conversation', guidance: 'x' }).success).toBe(false);
    expect(ExtractionHintInputZ.safeParse({ scope: 'global', guidance: 'x' }).success).toBe(true);
  });

  it('caps guidance length', () => {
    expect(ExtractionHintInputZ.safeParse({ scope: 'global', guidance: 'x'.repeat(600) }).success).toBe(false);
  });

  it('renders hints to compact operator strings with example', () => {
    const strs = hintsToOperatorStrings([
      { guidance: 'МАХ = мессенджер MAX', targetField: 'platform', exampleInput: 'МАХ 25000', exampleOutput: 'platform=max' },
      { guidance: 'plain', targetField: null, exampleInput: null, exampleOutput: null },
    ]);
    expect(strs[0]).toContain('[platform]');
    expect(strs[0]).toContain('пример');
    expect(strs[1]).toBe('plain');
  });
});

describe('reanalyze request', () => {
  it('supersede defaults true', () => {
    expect(ReanalyzeRequestZ.parse({}).supersede).toBe(true);
    expect(ReanalyzeRequestZ.parse({ supersede: false }).supersede).toBe(false);
  });
});
