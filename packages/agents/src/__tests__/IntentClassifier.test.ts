import { describe, expect, it } from 'vitest';

import { INTENTS, intentClassifier } from '../agents/IntentClassifier.js';
import { resolveForceHandoffIntents } from '@nosquare/shared';

import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * IntentClassifier agency intents (agency-sourcing-matching task 4.4/4.6):
 * the commercial price-agreement / quote intents are part of the output enum
 * so the agency type's forceHandoffIntents can escalate them — without
 * dropping any existing CustDev intent.
 */
describe('intent_classifier — agency commercial intents', () => {
  it('keeps every legacy intent and adds discusses_price + sends_quote', () => {
    // Legacy intents still present (regression).
    for (const legacy of [
      'interested',
      'needs_more_info',
      'asks_about_product',
      'objection_busy',
      'objection_irrelevant',
      'objection_compensation',
      'wants_payment_for_ads',
      'wants_to_schedule',
      'declined',
      'hostile',
      'spam_complaint',
      'request_human',
      'silence_likely',
    ]) {
      expect(INTENTS).toContain(legacy);
    }
    // New agency intents.
    expect(INTENTS).toContain('discusses_price');
    expect(INTENTS).toContain('sends_quote');
  });

  it('classifies a price discussion as discusses_price', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        intent: 'discusses_price',
        confidence: 0.9,
        signals: ['назвал цену за пост'],
      }),
    });
    const ctx = makeCtx({ llm, config: makeConfig({ systemPrompt: '', userPromptTemplate: '' }) });
    const out = await intentClassifier.run(
      { last_inbound: 'Пост стоит 15 тысяч, сторис 5.', history_tail: [] },
      ctx,
    );
    expect(out.intent).toBe('discusses_price');
  });

  it('the agency force-handoff policy escalates these intents', () => {
    const intents = resolveForceHandoffIntents({
      forceHandoffIntents: ['discusses_price', 'sends_quote', 'wants_payment_for_ads'],
    });
    expect(intents).toContain('discusses_price');
    expect(intents).toContain('sends_quote');
    // Both are valid classifier outputs → the worker can match them.
    expect(INTENTS).toContain('discusses_price');
    expect(INTENTS).toContain('sends_quote');
  });
});
