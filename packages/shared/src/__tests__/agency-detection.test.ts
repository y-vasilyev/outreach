import { describe, expect, it } from 'vitest';

import { preGateExtraction, hasCommercialSignal } from '../agency-detection.js';

/**
 * Pre-gate classifier for `profile-extract` (harden-agency-sourcing-pipeline).
 * The goal is to skip ONLY obviously empty service-talk turns ("ок",
 * "договорились") and never silently drop a real fact ("прайс отправлю",
 * "70% женщины"). Each pass returns the structured `reason` so the worker
 * can count `passed_by` / `skipped_by` in logs and tune later.
 */
describe('preGateExtraction', () => {
  describe('pass via keyword', () => {
    it.each([
      ['прайс отправлю', 'keyword-only short reply'],
      ['медиакит в pdf', 'media-kit mention'],
      ['стоимость пятнадцать тысяч', 'spelled-out amount + keyword'],
      ['по форматам напишу', 'format keyword'],
      ['не размещаю рекламу', 'declines but worth processing'],
      ['пост от 50000', 'format + amount'],
      ['у меня сторис тоже есть', 'sторис keyword'],
      ['аудитория 25-35', 'audience keyword'],
      ['основной демограф — мамы', 'demographic keyword'],
      ['география Россия / СНГ', 'geo keyword'],
    ])('"%s" → pass=keyword (%s)', (text) => {
      expect(preGateExtraction(text)).toEqual({ pass: true, reason: 'keyword' });
    });
  });

  describe('pass via amount_number', () => {
    it.each([
      '80к',
      '5к',
      '15k',
      '15000',
      '15 000',
      '15.000',
      '200000',
      'у меня 80к в среднем',
    ])('"%s" → pass=amount_number', (text) => {
      const result = preGateExtraction(text);
      // Some of these also contain keywords; the function checks keyword
      // first, so the reason is keyword in that case. Just assert pass.
      expect(result.pass).toBe(true);
      if (result.reason !== 'keyword') {
        expect(result.reason).toBe('amount_number');
      }
    });

    it('"5kg" → NOT amount_number (k is followed by a letter)', () => {
      // 5kg looks like an amount but the k+letter pattern is excluded.
      // Skipped or caught by other rule. Just assert it's not classified
      // as amount.
      const result = preGateExtraction('5kg');
      if (result.pass) expect(result.reason).not.toBe('amount_number');
    });
  });

  describe('pass via audience_number', () => {
    it.each([
      ['70%', 'percent'],
      ['70 %', 'percent with space'],
      ['18-34', 'age range hyphen'],
      ['25–35', 'age range en-dash'],
      ['25—35', 'age range em-dash'],
    ])('"%s" → pass=audience_number (%s)', (text) => {
      expect(preGateExtraction(text)).toEqual({ pass: true, reason: 'audience_number' });
    });
  });

  describe('pass via long_text', () => {
    it('long reply without any commercial marker still passes', () => {
      const text =
        'Спасибо за интерес к моему каналу, постараюсь ответить в ближайшее время, сейчас немного занят.';
      expect(text.length).toBeGreaterThan(60);
      expect(preGateExtraction(text)).toEqual({ pass: true, reason: 'long_text' });
    });
  });

  describe('skip via short_no_signal', () => {
    it.each([
      'ок',
      'хорошо',
      'договорились',
      'спасибо',
      'ага',
      'понял',
      'напишу в 5',
      'к 18:00',
      'до встречи',
      'конечно отправлю позже',
    ])('"%s" → skip=short_no_signal', (text) => {
      expect(preGateExtraction(text)).toEqual({ pass: false, reason: 'short_no_signal' });
    });

    it('empty / whitespace / non-string → skip', () => {
      expect(preGateExtraction('')).toEqual({ pass: false, reason: 'short_no_signal' });
      expect(preGateExtraction(null as unknown as string)).toEqual({
        pass: false,
        reason: 'short_no_signal',
      });
    });
  });

  describe('hasCommercialSignal back-compat boolean', () => {
    it('returns true for any pass case', () => {
      expect(hasCommercialSignal('прайс отправлю')).toBe(true);
      expect(hasCommercialSignal('80к')).toBe(true);
      expect(hasCommercialSignal('70% женщины')).toBe(true);
    });
    it('returns false for skip cases', () => {
      expect(hasCommercialSignal('ок')).toBe(false);
      expect(hasCommercialSignal('напишу в 5')).toBe(false);
    });
  });
});
