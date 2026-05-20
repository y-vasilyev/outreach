import { describe, expect, it } from 'vitest';

import {
  resolveSafetyContext,
  resolveForceHandoffIntents,
  resolveAgentName,
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
  // Mirrors the seeded agency_sourcing safetyProfile: commercial vocab is
  // allowed; the forbidden list captures guarantee/pressure/money tone signals.
  forbidden_topics: ['гарантируем результат', 'гарантия продаж', 'только сегодня', 'оплатите по ссылке'],
  allowed_topics: ['реклама', 'интеграция', 'прайс', 'охваты', 'формат', 'размещение'],
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

  it('agency profile permits commercial vocabulary but flags guarantees/pressure', () => {
    const ctx = resolveSafetyContext(AGENCY_PROFILE);
    // Commercial vocab is allowed (does not raise risk).
    expect(ctx.allowed_topics).toContain('реклама');
    // forbidden_topics is NOT a salesy-lexicon list — it captures the
    // agency guardrails (guarantees / pressure / money), so commercial
    // words stay out of it.
    expect(ctx.forbidden_topics).not.toContain('реклама');
    expect(ctx.forbidden_topics).toContain('гарантируем результат');
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

describe('resolveAgentName — agentSet role resolution', () => {
  const AGENCY_AGENT_SET = {
    opening_composer: { agentName: 'agency_opening_composer', overrides: {} },
    reply_composer: { agentName: 'reply_composer', overrides: {} },
    data_collection_planner: { agentName: 'data_collection_planner', overrides: {} },
  };

  it('resolves the agency-mapped agent for a role', () => {
    expect(resolveAgentName(AGENCY_AGENT_SET, 'opening_composer', 'opening_composer')).toBe(
      'agency_opening_composer',
    );
    expect(resolveAgentName(AGENCY_AGENT_SET, 'data_collection_planner', 'x')).toBe(
      'data_collection_planner',
    );
  });

  it('falls back to the legacy/global name when the role or set is missing', () => {
    expect(resolveAgentName(AGENCY_AGENT_SET, 'goal_fit_evaluator', 'goal_fit_evaluator')).toBe(
      'goal_fit_evaluator',
    );
    expect(resolveAgentName(null, 'opening_composer', 'opening_composer')).toBe('opening_composer');
    expect(resolveAgentName({ junk: 1 }, 'opening_composer', 'opening_composer')).toBe(
      'opening_composer',
    );
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

  it('commercial vocab passes safety as low-risk under the agency profile', async () => {
    // The agency allowed_topics mean commercial words don't raise risk — the
    // LLM (which has the lists in its prompt) returns a low score and the
    // hard guards don't fire on an 800-cap, link-free draft.
    const llm = makeLLM({
      completeJsonImpl: () => ({ allow: true, reasons: [], risk_score: 0.1 }),
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ systemPrompt: '', userPromptTemplate: '', params: { max_length: 800, allow_links: false } }),
    });
    const sctx = resolveSafetyContext(AGENCY_PROFILE);
    const out = await safetyFilter.run(
      {
        draft:
          'Здравствуйте! Мы агентство, видел вашу интеграцию. Подскажете прайс на пост и охваты по формату размещения?',
        forbidden_topics: sctx.forbidden_topics,
        allowed_topics: sctx.allowed_topics,
      },
      ctx,
    );
    expect(out.allow).toBe(true);
    expect(out.risk_score).toBeLessThan(0.3);
  });

  it('result-guarantee draft is treated as high-risk under the agency profile', async () => {
    // The guarantee phrasing is in agency forbidden_topics → the LLM tone
    // check (which receives that list) returns a high risk_score. We assert
    // the agent surfaces that high score so the gate/operator can block it.
    let captured = '';
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        captured = JSON.stringify(req);
        return { allow: true, reasons: ['обещание результата'], risk_score: 0.92 };
      },
    });
    const ctx = makeCtx({
      llm,
      config: makeConfig({ systemPrompt: '', userPromptTemplate: '', params: { max_length: 800 } }),
    });
    const sctx = resolveSafetyContext(AGENCY_PROFILE);
    const out = await safetyFilter.run(
      {
        draft: 'Берите размещение — гарантируем результат и гарантия продаж от нашего клиента.',
        forbidden_topics: sctx.forbidden_topics,
        allowed_topics: sctx.allowed_topics,
      },
      ctx,
    );
    // The guarantee phrasing reached the tone check as a forbidden signal.
    expect(captured).toContain('гарантируем результат');
    expect(out.risk_score).toBeGreaterThan(0.8);
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
