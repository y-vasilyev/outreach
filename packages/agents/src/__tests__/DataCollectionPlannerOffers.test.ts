import { describe, expect, it } from 'vitest';

import {
  loadActiveRegistry,
  validateOfferAttributes,
  missingRequiredAttributes,
  type PlacementOfferDraft,
} from '@nosquare/shared';

import { dataCollectionPlanner } from '../agents/DataCollectionPlanner.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * DataCollectionPlanner — structured placement offers (entity-style-rate-cards,
 * Section 4). When a known offer has a usable price but is missing a required
 * attribute, the planner asks a FOCUSED follow-up about that attribute instead
 * of re-asking the whole rate card. Inactive attribute proposals never count as
 * collected and never satisfy the goal.
 */
describe('data_collection_planner — placement offers', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });
  const TARGETS = ['rate_card', 'reach', 'audience_demographics', 'geo'];

  // A telegram post with a confident price but NO delete_policy/duration —
  // both are required for kind=post in the v1 registry.
  const pricedPostMissingAttrs: PlacementOfferDraft = {
    kind: 'post',
    platform: 'telegram',
    price: 15000,
    currency: 'RUB',
    rawPrice: '',
    confidence: 0.9,
    rawSnippet: 'пост 15000',
    attributes: [],
  };

  it('asks a focused attribute follow-up instead of re-asking the rate card', async () => {
    let captured = '';
    const llm = makeLLM({
      completeJsonImpl: (req) => {
        captured = JSON.stringify(req);
        // LLM correctly targets the delete_policy attribute.
        return {
          next_attribute_key: 'delete_policy',
          reply: 'Подскажите, пост удаляется по истечении срока или остаётся навсегда?',
          goal_satisfied: false,
          rationale: 'price known, chase delete_policy',
        };
      },
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        // Even though rate_card is "collected" at the coarse level, the offer
        // is missing required attributes, so the planner must NOT close.
        collected_data_points: ['rate_card'],
        history_tail: [],
        last_inbound: 'Пост 15000',
        placement_offers: [pricedPostMissingAttrs],
        required_attribute_keys: [],
      },
      ctx,
    );
    expect(out.goal_satisfied).toBe(false);
    expect(out.next_attribute_key).toBe('delete_policy');
    // It must not be re-asking for price.
    expect(out.reply).not.toMatch(/сколько стоит|какой прайс|цена\?/i);
    // The follow-up + the offer are fed to the LLM.
    expect(captured).toContain('attribute_followups');
    expect(captured).toContain('delete_policy');
  });

  it('overrides to a deterministic focused question when the LLM picks a non-pending attribute', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        // LLM picks an attribute that is not a pending follow-up.
        next_attribute_key: 'notes',
        reply: 'Сколько стоит пост?',
        goal_satisfied: false,
        rationale: 'wrong pick',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        collected_data_points: ['rate_card'],
        history_tail: [],
        last_inbound: '',
        placement_offers: [pricedPostMissingAttrs],
        required_attribute_keys: [],
      },
      ctx,
    );
    // Forced to a genuinely-pending required attribute (delete_policy or duration).
    expect(['delete_policy', 'duration']).toContain(out.next_attribute_key);
    // Deterministic focused question — never the LLM's price re-ask.
    expect(out.reply).not.toMatch(/стоит пост/i);
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it('does NOT re-ask price when a usable price exists (closes once attributes filled)', async () => {
    const fullyDescribedOffer: PlacementOfferDraft = {
      kind: 'post',
      platform: 'telegram',
      price: 15000,
      currency: 'RUB',
      rawPrice: '',
      confidence: 0.9,
      rawSnippet: 'пост 15000 навсегда сутки',
      attributes: [
        { key: 'delete_policy', value: 'permanent', confidence: 1, rawSnippet: 'без удаления' },
        { key: 'duration', value: 'day', confidence: 1, rawSnippet: 'на сутки' },
      ],
    };
    const llm = makeLLM({
      completeJsonImpl: () => ({
        reply: 'Спасибо!',
        goal_satisfied: true,
        rationale: 'all collected',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: ['rate_card'],
        collected_data_points: ['rate_card'],
        history_tail: [],
        last_inbound: '',
        placement_offers: [fullyDescribedOffer],
        required_attribute_keys: [],
      },
      ctx,
    );
    // No pending attribute + no missing target ⇒ goal satisfied, no re-ask.
    expect(out.goal_satisfied).toBe(true);
    expect(out.next_attribute_key).toBeUndefined();
    expect(out.next_data_point).toBeUndefined();
  });

  it('keeps legacy missing-target behaviour when no offers are provided (flag-off shape)', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        next_data_point: 'reach',
        reply: 'Какие у вас охваты?',
        goal_satisfied: false,
        rationale: 'ask reach',
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await dataCollectionPlanner.run(
      {
        target_data_points: TARGETS,
        collected_data_points: ['rate_card'],
        history_tail: [],
        last_inbound: '',
        placement_offers: [],
        required_attribute_keys: [],
      },
      ctx,
    );
    // Behaves exactly as before: coarse missing-target path, no attribute key.
    expect(out.next_attribute_key).toBeUndefined();
    expect(out.next_data_point).toBe('reach');
    expect(out.target_field).toBe('reach');
  });

  it('an inactive (proposed/rejected) attribute does not become required and does not complete a target', () => {
    // The DB has the v1 registry active + a PROPOSED attribute `exclusivity`
    // marked required-for post, and a REJECTED one. Only the v1 active set
    // should drive required attributes; the proposals are inert.
    const rows = [
      // simulate an approved/active custom attribute
      {
        key: 'placement_slot',
        valueType: 'string',
        description: 'Слот',
        applicableKinds: ['post'],
        enumValues: [],
        requiredForKinds: [],
        status: 'active',
      },
      // proposed — must be ignored by loadActiveRegistry
      {
        key: 'exclusivity',
        valueType: 'boolean',
        description: 'Эксклюзив',
        applicableKinds: ['post'],
        enumValues: [],
        requiredForKinds: ['post'],
        status: 'proposed',
      },
      // rejected — must be ignored
      {
        key: 'bad_attr',
        valueType: 'string',
        description: 'x',
        applicableKinds: [],
        enumValues: [],
        requiredForKinds: ['post'],
        status: 'rejected',
      },
    ];
    const registry = loadActiveRegistry(rows);

    // The active registry includes v1 + the active custom one, but NOT the
    // proposed/rejected keys.
    expect(registry.some((e) => e.key === 'placement_slot')).toBe(true);
    expect(registry.some((e) => e.key === 'exclusivity')).toBe(false);
    expect(registry.some((e) => e.key === 'bad_attr')).toBe(false);

    const offer: PlacementOfferDraft = {
      kind: 'post',
      platform: 'telegram',
      price: 15000,
      currency: 'RUB',
      rawPrice: '',
      confidence: 0.9,
      rawSnippet: 'пост 15000',
      // Carries an `exclusivity` value, but since the key is only PROPOSED, it
      // is an "unknown" attribute (not accepted as a collected fact).
      attributes: [
        { key: 'delete_policy', value: 'permanent', confidence: 1, rawSnippet: '' },
        { key: 'duration', value: 'day', confidence: 1, rawSnippet: '' },
        { key: 'exclusivity', value: true, confidence: 1, rawSnippet: '' },
      ],
    };

    // The proposed `exclusivity` is NOT a required attribute, so it does not
    // appear as missing (it is simply not part of the schema yet).
    const missing = missingRequiredAttributes(offer, registry);
    expect(missing).not.toContain('exclusivity');

    // And the proposed-key value is reported as `unknown`, not `valid` — so it
    // never counts as a collected/validated fact.
    const v = validateOfferAttributes(offer, registry);
    expect(v.unknown.some((a) => a.key === 'exclusivity')).toBe(true);
    expect(v.valid.some((a) => a.key === 'exclusivity')).toBe(false);
  });
});
