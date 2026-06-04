import { describe, expect, it } from 'vitest';

import {
  buildHudTargetRow,
  DATA_COLLECTION_TARGETS,
  getSuggestionTargetField,
  getTarget,
  profileFieldMatchesTarget,
  resolveEffectiveHudTargets,
  resolveEffectivePlannerTargets,
  targetsForProfileField,
} from '../data-collection-targets.js';

/**
 * Data-collection target registry + helpers (data-collection-hud-target-fields
 * change, Phase 1).
 */
describe('data-collection-targets', () => {
  describe('registry load', () => {
    it('exposes all four agency defaults plus the manual-only deals_contact', () => {
      const expected = ['rate_card', 'reach', 'audience_demographics', 'geo', 'deals_contact'];
      for (const key of expected) {
        const entry = getTarget(key);
        expect(entry, `missing ${key}`).toBeDefined();
        expect(entry?.label.length).toBeGreaterThan(0);
        expect(entry?.description_for_operator.length).toBeGreaterThan(0);
        expect(entry?.description_for_agent.length).toBeGreaterThan(0);
        expect(entry?.question_template.length).toBeGreaterThan(0);
        expect(entry?.profile_data_point_keys.length).toBeGreaterThan(0);
      }
      expect(getTarget('deals_contact')?.manual_only).toBe(true);
      // Automated agency targets must not be manual_only.
      for (const key of ['rate_card', 'reach', 'audience_demographics', 'geo']) {
        expect(getTarget(key)?.manual_only).not.toBe(true);
      }
    });

    it('exposes a stable set so adding a new key is an explicit change', () => {
      expect(Object.keys(DATA_COLLECTION_TARGETS).sort()).toEqual([
        'audience_demographics',
        'deals_contact',
        'geo',
        'rate_card',
        'reach',
      ]);
    });
  });

  describe('profileFieldMatchesTarget', () => {
    it('matches a root key exactly', () => {
      const target = getTarget('reach')!;
      expect(profileFieldMatchesTarget('reach', target)).toBe(true);
    });

    it('matches a dotted sub-key', () => {
      const target = getTarget('rate_card')!;
      // rate.post is the canonical extractor output for rate_card.
      expect(profileFieldMatchesTarget('rate.post', target)).toBe(true);
    });

    it('keeps audience_demographics distinct from geo', () => {
      const audience = getTarget('audience_demographics')!;
      const geo = getTarget('geo')!;
      // audience.geo MUST NOT count toward demographics — that was the
      // exact bug `harden-agency-sourcing-pipeline` fixed and Phase 1
      // re-enforces through the registry.
      expect(profileFieldMatchesTarget('audience.geo', audience)).toBe(false);
      expect(profileFieldMatchesTarget('audience.geo', geo)).toBe(true);
      // audience.age / audience.gender match demographics, not geo.
      expect(profileFieldMatchesTarget('audience.age', audience)).toBe(true);
      expect(profileFieldMatchesTarget('audience.gender', geo)).toBe(false);
    });

    it('rejects a non-dotted near-miss', () => {
      const target = getTarget('rate_card')!;
      // `rateLimit` shares the prefix `rate` but is NOT a dotted sub-key.
      expect(profileFieldMatchesTarget('rateLimit', target)).toBe(false);
    });
  });

  describe('targetsForProfileField', () => {
    it('returns the affected target list for a written field', () => {
      const keys = targetsForProfileField('rate.story').map((t) => t.key);
      expect(keys).toContain('rate_card');
      expect(keys).not.toContain('audience_demographics');
    });

    it('returns multiple targets when keys overlap', () => {
      // No overlap in the v1 registry (each field belongs to one target)
      // but the helper must handle the overlap-free case too.
      const keys = targetsForProfileField('audience.age').map((t) => t.key);
      expect(keys).toEqual(['audience_demographics']);
    });
  });

  describe('resolveEffectiveHudTargets / resolveEffectivePlannerTargets', () => {
    it('falls back to the agency default set when goal.target_data_points is unset', () => {
      const hud = resolveEffectiveHudTargets({ goal: {} }).map((t) => t.key);
      expect(hud).toEqual(['rate_card', 'reach', 'audience_demographics', 'geo']);
    });

    it('intersects with the registry and drops unknown keys', () => {
      const dropped: string[] = [];
      const hud = resolveEffectiveHudTargets(
        { goal: { target_data_points: ['rate_card', 'unknown_key', 'reach'] } },
        (k) => dropped.push(k),
      ).map((t) => t.key);
      expect(hud).toEqual(['rate_card', 'reach']);
      expect(dropped).toEqual(['unknown_key']);
    });

    it('planner targets exclude manual_only', () => {
      const hud = resolveEffectiveHudTargets({
        goal: { target_data_points: ['rate_card', 'deals_contact'] },
      }).map((t) => t.key);
      const planner = resolveEffectivePlannerTargets({
        goal: { target_data_points: ['rate_card', 'deals_contact'] },
      }).map((t) => t.key);
      expect(hud).toEqual(['rate_card', 'deals_contact']);
      expect(planner).toEqual(['rate_card']);
    });

    it('a null campaign yields the default set on HUD and planner alike', () => {
      const hud = resolveEffectiveHudTargets(null).map((t) => t.key);
      const planner = resolveEffectivePlannerTargets(null).map((t) => t.key);
      expect(hud).toEqual(['rate_card', 'reach', 'audience_demographics', 'geo']);
      expect(planner).toEqual(hud);
    });
  });

  describe('getSuggestionTargetField', () => {
    it('reads a camelCase targetField from Suggestion.meta', () => {
      expect(getSuggestionTargetField({ meta: { targetField: 'reach' } })).toBe('reach');
    });

    it('returns undefined for missing / non-string values', () => {
      expect(getSuggestionTargetField({})).toBeUndefined();
      expect(getSuggestionTargetField(null)).toBeUndefined();
      expect(getSuggestionTargetField({ meta: null })).toBeUndefined();
      expect(getSuggestionTargetField({ meta: { targetField: 42 } })).toBeUndefined();
      expect(getSuggestionTargetField({ meta: { targetField: '' } })).toBeUndefined();
    });
  });

  describe('buildHudTargetRow', () => {
    const now = new Date('2026-06-04T00:00:00.000Z');

    it('reports answered with fresh contributing data', () => {
      const target = getTarget('rate_card')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'rate.post',
            value: 15000,
            capturedAt: new Date(now.getTime() - 10 * 86_400_000),
            sourceMessageId: 'msg-1',
          },
        ],
        null,
      );
      expect(row.state).toBe('answered');
      expect(row.current?.value).toBe(15000);
      expect(row.current?.sourceMessageId).toBe('msg-1');
      expect(row.freshness?.stale).toBe(false);
    });

    it('reports stale when the contributing data point is past TTL', () => {
      const target = getTarget('rate_card')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'rate.post',
            value: 15000,
            // 91 days > rate-card TTL 90 days.
            capturedAt: new Date(now.getTime() - 91 * 86_400_000),
            sourceMessageId: null,
          },
        ],
        null,
      );
      expect(row.state).toBe('stale');
      expect(row.freshness?.stale).toBe(true);
    });

    it('reports asked when there is no data point but a suggestion targeted it', () => {
      const target = getTarget('geo')!;
      const askedAt = new Date(now.getTime() - 2 * 3_600_000);
      const row = buildHudTargetRow(target, [], askedAt);
      expect(row.state).toBe('asked');
      expect(row.lastAskedAt).toBe(askedAt.toISOString());
      expect(row.current).toBeUndefined();
    });

    it('reports missing when neither asked nor answered', () => {
      const target = getTarget('reach')!;
      const row = buildHudTargetRow(target, [], null);
      expect(row.state).toBe('missing');
      expect(row.current).toBeUndefined();
      expect(row.lastAskedAt).toBeUndefined();
    });

    it('keeps audience_demographics and geo independent', () => {
      const audience = getTarget('audience_demographics')!;
      const geo = getTarget('geo')!;
      const points = [
        {
          field: 'audience.geo',
          value: { RU: 0.7, KZ: 0.2 },
          capturedAt: new Date(now.getTime() - 5 * 86_400_000),
          sourceMessageId: 'm-geo',
        },
      ];
      const audienceRow = buildHudTargetRow(audience, points, null);
      const geoRow = buildHudTargetRow(geo, points, null);
      // The geo data point must NOT count as demographics.
      expect(audienceRow.state).toBe('missing');
      expect(geoRow.state).toBe('answered');
    });

    it('manual_only targets ignore data points entirely', () => {
      const target = getTarget('deals_contact')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'contact.note',
            value: 'manager @x',
            capturedAt: new Date(now.getTime() - 5 * 86_400_000),
            sourceMessageId: 'm-c',
          },
        ],
        null,
      );
      expect(row.state).toBe('missing');
      expect(row.current).toBeUndefined();
    });
  });
});
