import { describe, expect, it } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';

import { campaignTypesService } from '../campaign-types.js';

/**
 * validateGoal is the registry's goal-vs-type contract (agency-sourcing-
 * matching, campaign-type-registry spec). custdev reuses the AJTBD zod
 * schema; other types enforce their goalSchema.required list. Pure — no DB.
 */
describe('campaignTypesService.validateGoal', () => {
  const custdev = { key: 'custdev', goalSchema: {} };
  const agency = {
    key: 'agency_sourcing',
    goalSchema: { type: 'object', required: ['target_data_points'] },
  };

  it('accepts a well-formed custdev (AJTBD) goal', () => {
    const goal = campaignTypesService.validateGoal(custdev, {
      job: 'CustDev по продукту',
      when: '',
      forces: { push: [], pull: [], anxieties: [], habits: [] },
      desired_outcome: 'узнать боль',
      non_goals: [],
    });
    expect(goal).toMatchObject({ job: 'CustDev по продукту' });
  });

  it('rejects a custdev goal with wrong types (400)', () => {
    try {
      campaignTypesService.validateGoal(custdev, { job: 42 });
      throw new Error('expected validateGoal to throw');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) expect(e.statusCode).toBe(400);
    }
  });

  it('accepts an agency goal that has the required field', () => {
    const goal = campaignTypesService.validateGoal(agency, {
      target_data_points: ['reach', 'rate_card'],
    });
    expect(goal).toMatchObject({ target_data_points: ['reach', 'rate_card'] });
  });

  it('rejects an agency goal missing a required field (400, names the field)', () => {
    try {
      campaignTypesService.validateGoal(agency, { client_brief: 'X' });
      throw new Error('expected validateGoal to throw');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.statusCode).toBe(400);
        expect(JSON.stringify(e.details ?? {})).toContain('target_data_points');
      }
    }
  });

  it('rejects a non-object agency goal', () => {
    expect(() => campaignTypesService.validateGoal(agency, null)).toThrow();
    expect(() => campaignTypesService.validateGoal(agency, 'nope')).toThrow();
  });
});
