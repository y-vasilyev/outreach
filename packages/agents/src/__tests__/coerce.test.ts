import { describe, expect, it } from 'vitest';

import {
  IntentTargetCoerced,
  IntentTargetEnum,
  LanguageCoerced,
  LengthCoerced,
  ToneCoerced,
  UrgencyCoerced,
  HandoffActionCoerced,
  RiskScoreCoerced,
  ConfidenceCoerced,
} from '../agents/_coerce.js';

describe('soft-field coercers (z.catch)', () => {
  it('IntentTargetCoerced: confirm_meeting is now first-class', () => {
    expect(IntentTargetEnum.options).toContain('confirm_meeting');
    expect(IntentTargetCoerced.parse('confirm_meeting')).toBe('confirm_meeting');
  });

  it('IntentTargetCoerced: unknown label falls back to answer_question', () => {
    expect(IntentTargetCoerced.parse('clarify_or_close')).toBe('answer_question');
    expect(IntentTargetCoerced.parse('schedule_interview')).toBe('answer_question');
    expect(IntentTargetCoerced.parse('')).toBe('answer_question');
    expect(IntentTargetCoerced.parse(42)).toBe('answer_question');
  });

  it('ToneCoerced: unknown tone falls back to neutral', () => {
    expect(ToneCoerced.parse('formal')).toBe('formal');
    expect(ToneCoerced.parse('неформальный, личный')).toBe('neutral');
    expect(ToneCoerced.parse(undefined)).toBe('neutral');
  });

  it('LanguageCoerced: unknown language falls back to other', () => {
    expect(LanguageCoerced.parse('ru')).toBe('ru');
    expect(LanguageCoerced.parse('русский')).toBe('other');
    expect(LanguageCoerced.parse('')).toBe('other');
  });

  it('UrgencyCoerced: unknown urgency falls back to normal', () => {
    expect(UrgencyCoerced.parse('high')).toBe('high');
    expect(UrgencyCoerced.parse('срочно')).toBe('normal');
  });

  it('LengthCoerced: numeric char count maps deterministically; unknown string → medium', () => {
    expect(LengthCoerced.parse(50)).toBe('short');
    expect(LengthCoerced.parse(200)).toBe('medium');
    expect(LengthCoerced.parse(500)).toBe('long');
    expect(LengthCoerced.parse('long')).toBe('long');
    expect(LengthCoerced.parse('развёрнутый')).toBe('medium');
  });
});

describe('hard-field coercers stay strict', () => {
  it('HandoffActionCoerced still maps obvious synonyms (operator_now is safest fallback)', () => {
    expect(HandoffActionCoerced.parse('escalate to human')).toBe('operator_now');
    expect(HandoffActionCoerced.parse('ai_continue')).toBe('ai_continue');
    expect(HandoffActionCoerced.parse('continue dialog')).toBe('ai_continue');
  });

  it('HandoffActionCoerced rejects truly unknown values (repair-loop will retry)', () => {
    expect(() => HandoffActionCoerced.parse('frobnicate')).toThrow();
  });

  it('RiskScoreCoerced normalises 0..100 percent to 0..1', () => {
    expect(RiskScoreCoerced.parse(0.4)).toBeCloseTo(0.4, 5);
    expect(RiskScoreCoerced.parse(75)).toBeCloseTo(0.75, 5);
    expect(RiskScoreCoerced.parse('high')).toBeCloseTo(0.85, 5);
  });

  it('ConfidenceCoerced clamps and accepts qualitative strings', () => {
    expect(ConfidenceCoerced.parse(0.6)).toBeCloseTo(0.6, 5);
    expect(ConfidenceCoerced.parse('medium')).toBeCloseTo(0.6, 5);
    expect(ConfidenceCoerced.parse(2)).toBe(1);
  });
});
