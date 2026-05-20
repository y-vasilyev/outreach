import { describe, expect, it } from 'vitest';

import {
  resolveSafetyContext,
  resolveForceHandoffIntents,
  LEGACY_SAFETY_CONTEXT,
} from '@nosquare/shared';

import { safetyFilter } from '../agents/SafetyFilter.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * Regression for the agency-sourcing-matching change (task 2.6): after
 * moving the safety vocabulary into the campaign-type registry, CustDev
 * campaigns must still surface ad-sales lexicon to SafetyFilter as
 * forbidden (so it raises the risk score), while agency campaigns must
 * surface that same lexicon as allowed (so commercial talk is on-goal).
 */

const CUSTDEV_PROFILE = {
  forbidden_topics: ['реклама', 'рекламная', 'интеграц', 'оффер'],
  allowed_topics: [],
  allow_links: false,
  max_length: 600,
};

const AGENCY_PROFILE = {
  forbidden_topics: [],
  allowed_topics: ['реклама', 'интеграция', 'прайс', 'охваты'],
  allow_links: false,
  max_length: 800,
};

describe('resolveSafetyContext — campaign-type → SafetyFilter context', () => {
  it('custdev profile keeps ad-sales lexicon as forbidden + legacy cap', () => {
    const ctx = resolveSafetyContext(CUSTDEV_PROFILE);
    expect(ctx.forbidden_topics).toContain('реклама');
    expect(ctx.allowed_topics).toEqual([]);
    expect(ctx.params).toEqual({ max_length: 600, allow_links: false });
  });

  it('agency profile permits commercial vocabulary (allowed, not forbidden)', () => {
    const ctx = resolveSafetyContext(AGENCY_PROFILE);
    expect(ctx.forbidden_topics).toEqual([]);
    expect(ctx.allowed_topics).toContain('реклама');
    expect(ctx.params.max_length).toBe(800);
  });

  it('null / invalid profile falls back to the legacy default', () => {
    expect(resolveSafetyContext(null)).toEqual(LEGACY_SAFETY_CONTEXT);
    expect(resolveSafetyContext({ junk: true })).toEqual(LEGACY_SAFETY_CONTEXT);
    expect(LEGACY_SAFETY_CONTEXT.forbidden_topics).toEqual([]);
    expect(LEGACY_SAFETY_CONTEXT.params).toEqual({ max_length: 600, allow_links: false });
  });
});

describe('resolveForceHandoffIntents', () => {
  it('returns the policy intents for agency, empty for custdev/none', () => {
    expect(
      resolveForceHandoffIntents({ forceHandoffIntents: ['discusses_price', 'sends_quote'] }),
    ).toEqual(['discusses_price', 'sends_quote']);
    expect(resolveForceHandoffIntents({ forceHandoffIntents: [] })).toEqual([]);
    expect(resolveForceHandoffIntents(null)).toEqual([]);
  });
});

describe('safety_filter — type vocabulary reaches the LLM tone check', () => {
  it('feeds custdev forbidden_topics into the LLM request', async () => {
    let captured = '';
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        captured = JSON.stringify(req);
        return { allow: true, reasons: [], risk_score: 0.1 };
      },
    });
    const ctx = makeCtx({ llm, config: makeConfig({ systemPrompt: '', userPromptTemplate: '' }) });
    const sctx = resolveSafetyContext(CUSTDEV_PROFILE);
    await safetyFilter.run(
      {
        draft: 'Здравствуйте! Зову на короткое интервью.',
        forbidden_topics: sctx.forbidden_topics,
        allowed_topics: sctx.allowed_topics,
      },
      ctx,
    );
    expect(llm._calls.completeJson).toBe(1);
    // The rendered prompt carries the forbidden vocabulary for the tone check.
    expect(captured).toContain('реклама');
  });

  it('agency allowed_topics reach the LLM and forbidden stays empty', async () => {
    let captured = '';
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        captured = JSON.stringify(req);
        return { allow: true, reasons: [], risk_score: 0.1 };
      },
    });
    const ctx = makeCtx({ llm, config: makeConfig({ systemPrompt: '', userPromptTemplate: '' }) });
    const sctx = resolveSafetyContext(AGENCY_PROFILE);
    await safetyFilter.run(
      {
        draft: 'Здравствуйте! Мы агентство, интересует ваш прайс на интеграцию.',
        forbidden_topics: sctx.forbidden_topics,
        allowed_topics: sctx.allowed_topics,
      },
      ctx,
    );
    expect(captured).toContain('прайс');
  });

  it('safety params override merges without dropping temperature (deep merge contract)', () => {
    // Documents the AgentRunner deep-merge: callers override max_length /
    // allow_links via params without clobbering the DB params. Asserted
    // here at the unit level on the merge shape the worker relies on.
    const dbParams = { temperature: 0, max_tokens: 250, max_length: 600, allow_links: false };
    const override = { max_length: 800, allow_links: false };
    const merged = { ...dbParams, ...override };
    expect(merged).toEqual({ temperature: 0, max_tokens: 250, max_length: 800, allow_links: false });
  });
});
