import { describe, expect, it } from 'vitest';

import { extractAjtbdView } from '../schemas/ajtbd.js';

/**
 * `extractAjtbdView` is the single bridge from `Campaign.goal` to the
 * AJTBD-shaped input that agents (ReplyComposer, HandoffDecider,
 * GoalFitEvaluator) historically expected. The discriminator is the
 * campaign's `type.key`: only `custdev` is treated as AJTBD-shaped;
 * every other type (agency_sourcing, builder-authored types) is
 * scaffolded from `goalText` / `valueProp`. After
 * `drop-campaign-ajtbd-column`, this is the only place that knows the
 * bridge.
 */
describe('extractAjtbdView', () => {
  const goalText = 'Понять, что мешает заказчикам платить за подписку';
  const valueProp = 'Сократим путь до подписки на 30%';

  it('passes through a custdev goal that already matches the AJTBD shape', () => {
    const goal = {
      job: 'Найти 5 мотиваторов отказа от подписки',
      when: 'после регистрации',
      forces: { push: ['слишком дорого'], pull: ['ROI'], anxieties: ['риск'], habits: [] },
      desired_outcome: 'купить годовую подписку',
      non_goals: ['продать апсейл'],
    };
    const view = extractAjtbdView({ goal, goalText, valueProp, typeKey: 'custdev' });
    expect(view.job).toBe('Найти 5 мотиваторов отказа от подписки');
    expect(view.desired_outcome).toBe('купить годовую подписку');
    expect(view.non_goals).toEqual(['продать апсейл']);
    expect(view.forces.push).toEqual(['слишком дорого']);
  });

  it('agency_sourcing goal scaffold surfaces target_data_points + agency non_goals', () => {
    // harden-agency-sourcing-pipeline: the agency scaffold lifts
    // `goal.target_data_points` into `desired_outcome` so downstream
    // GoalFitEvaluator sees what's actually being collected, and seeds
    // `non_goals` with the agency-specific anti-patterns the gate must
    // flag as `handoff_silent` (premature monetary commitment, fabricated
    // client details, guarantees). It does NOT pass the AJTBD shape from
    // `goal` through verbatim — the agency `goal_schema` doesn't match
    // CampaignAjtbdZ.
    const goal = {
      target_data_points: ['rate_card', 'audience_stats'],
      client_brief: 'fintech клиент',
    };
    const view = extractAjtbdView({ goal, goalText, valueProp, typeKey: 'agency_sourcing' });
    expect(view.job).toBe(goalText);
    expect(view.desired_outcome).toContain('rate_card');
    expect(view.desired_outcome).toContain('audience_stats');
    expect(view.when).toBe('');
    expect(view.non_goals.length).toBeGreaterThan(0);
    // Non-goals mention payment / guarantees / fabricated client details.
    const nonGoalsBlob = view.non_goals.join(' ').toLowerCase();
    expect(nonGoalsBlob).toMatch(/гаранти|оплат|выдум|комм/);
    expect(view.forces).toEqual({ push: [], pull: [], anxieties: [], habits: [] });
  });

  it('agency goal with no target_data_points falls back to valueProp as desired_outcome', () => {
    const goal = {
      // No target_data_points → desired_outcome falls back to valueProp.
      forces: { push: ['anything'], pull: [], anxieties: [], habits: [] },
    };
    const view = extractAjtbdView({ goal, goalText, valueProp, typeKey: 'agency_sourcing' });
    expect(view.job).toBe(goalText);
    expect(view.desired_outcome).toBe(valueProp);
    // Still seeded with agency non_goals (they don't depend on goal contents).
    expect(view.non_goals.length).toBeGreaterThan(0);
  });

  it('unknown / missing typeKey falls back conservatively to scaffold', () => {
    const goal = {
      job: 'Some custdev goal',
      forces: { push: [], pull: [], anxieties: [], habits: [] },
      desired_outcome: 'X',
      non_goals: [],
    };
    // typeKey omitted → not recognised as custdev → scaffold.
    const view = extractAjtbdView({ goal, goalText, valueProp });
    expect(view.job).toBe(goalText);
  });

  it('custdev goal that is null falls back to scaffold', () => {
    const view = extractAjtbdView({ goal: null, goalText, valueProp, typeKey: 'custdev' });
    expect(view.job).toBe(goalText);
    expect(view.desired_outcome).toBe(valueProp);
  });

  it('custdev goal with broken shape (wrong types) falls back to scaffold', () => {
    // `job` should be a string; pass a number to fail safeParse.
    const goal = { job: 12345 };
    const view = extractAjtbdView({ goal, goalText, valueProp, typeKey: 'custdev' });
    expect(view.job).toBe(goalText);
    expect(view.desired_outcome).toBe(valueProp);
  });

  it('custdev goal with minimal AJTBD fields parses through (zod defaults fill the rest)', () => {
    const goal = { job: 'X', desired_outcome: 'Y' };
    const view = extractAjtbdView({ goal, goalText, valueProp, typeKey: 'custdev' });
    expect(view.job).toBe('X');
    expect(view.desired_outcome).toBe('Y');
    expect(view.non_goals).toEqual([]);
    expect(view.forces).toEqual({ push: [], pull: [], anxieties: [], habits: [] });
  });
});
