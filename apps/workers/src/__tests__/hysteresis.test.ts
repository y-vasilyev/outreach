import { describe, expect, it } from 'vitest';

// Mock the cross-package side-effect imports that agent-run.ts pulls in
// at module load (BullMQ Worker, Redis, Prisma, runner). The hysteresis
// helper is a pure function — we just need its export, not the worker
// runtime.
import { vi } from 'vitest';
vi.mock('bullmq', () => ({ Worker: class {}, Queue: class {} }));
vi.mock('../redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('@nosquare/db', () => ({ getPrisma: () => ({}) }));

import { shouldFlipOnHandoff, readPriorQualityDecision } from '../queues/agent-run.js';

const cont = (score = 0.9) =>
  ({ action: 'continue' as const, score, reasons: [] });
const soften = (score = 0.7) =>
  ({ action: 'soften' as const, score, reasons: [] });
const handoff = (score = 0.4) =>
  ({ action: 'handoff_silent' as const, score, reasons: [] });

describe('shouldFlipOnHandoff (hysteresis)', () => {
  it('does NOT flip when current action is continue, regardless of previous', () => {
    expect(shouldFlipOnHandoff(cont(0.9), null)).toBe(false);
    expect(shouldFlipOnHandoff(cont(0.2), { action: 'handoff_silent', score: 0.2 })).toBe(false);
  });

  it('does NOT flip when current action is soften, regardless of previous', () => {
    expect(shouldFlipOnHandoff(soften(0.7), null)).toBe(false);
    expect(shouldFlipOnHandoff(soften(0.1), { action: 'handoff_silent' })).toBe(false);
  });

  it('does NOT flip on a single soft handoff (score=0.4, prev=continue)', () => {
    // Boundary case from the spec — score above 0.3 + previous wasn't
    // handoff_silent → "wait, see if next decision confirms".
    expect(shouldFlipOnHandoff(handoff(0.4), { action: 'continue', score: 0.85 })).toBe(false);
  });

  it('does NOT flip on a single soft handoff with no previous decision', () => {
    expect(shouldFlipOnHandoff(handoff(0.4), null)).toBe(false);
  });

  it('flips when score is exactly 0.3 (severe single-turn boundary)', () => {
    // 0.3 is INCLUSIVE — the spec says `score ≤ 0.3` triggers immediate flip.
    expect(shouldFlipOnHandoff(handoff(0.3), null)).toBe(true);
    expect(shouldFlipOnHandoff(handoff(0.3), { action: 'continue' })).toBe(true);
  });

  it('flips when score is below 0.3 (severe single-turn)', () => {
    expect(shouldFlipOnHandoff(handoff(0.1), null)).toBe(true);
    expect(shouldFlipOnHandoff(handoff(0.0), { action: 'continue' })).toBe(true);
  });

  it('does NOT flip at score = 0.31 with no prior handoff (just above the threshold)', () => {
    expect(shouldFlipOnHandoff(handoff(0.31), { action: 'continue' })).toBe(false);
  });

  it('flips on the second consecutive handoff_silent (any score above 0.3)', () => {
    expect(
      shouldFlipOnHandoff(handoff(0.5), { action: 'handoff_silent', score: 0.45 }),
    ).toBe(true);
  });

  it('flips when previous is undefined-action object but action is handoff_silent + score≤0.3', () => {
    // Defensive: a malformed previous record should not block a severe flip.
    expect(shouldFlipOnHandoff(handoff(0.2), {})).toBe(true);
  });

  it('does NOT flip when previous was soften (only handoff_silent counts as a prior)', () => {
    expect(shouldFlipOnHandoff(handoff(0.5), { action: 'soften', score: 0.65 })).toBe(false);
  });
});

describe('readPriorQualityDecision', () => {
  it('returns null for non-object inputs', () => {
    expect(readPriorQualityDecision(null)).toBeNull();
    expect(readPriorQualityDecision(undefined)).toBeNull();
    expect(readPriorQualityDecision('not an object')).toBeNull();
    expect(readPriorQualityDecision(42)).toBeNull();
  });

  it('returns null when no recognised fields are present', () => {
    expect(readPriorQualityDecision({})).toBeNull();
    expect(readPriorQualityDecision({ unrelated: 'thing' })).toBeNull();
  });

  it('parses a fully-populated decision', () => {
    const out = readPriorQualityDecision({
      action: 'handoff_silent',
      score: 0.4,
      decidedAt: '2026-05-08T10:00:00.000Z',
    });
    expect(out).toEqual({
      action: 'handoff_silent',
      score: 0.4,
      decidedAt: '2026-05-08T10:00:00.000Z',
    });
  });

  it('drops invalid action values but keeps valid score', () => {
    const out = readPriorQualityDecision({ action: 'made_up_action', score: 0.7 });
    expect(out).toEqual({ score: 0.7 });
  });

  it('drops non-string decidedAt', () => {
    const out = readPriorQualityDecision({ action: 'continue', decidedAt: 123 });
    expect(out).toEqual({ action: 'continue' });
  });
});
