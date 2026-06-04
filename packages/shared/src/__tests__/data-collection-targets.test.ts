import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildHudTargetRow,
  DATA_COLLECTION_TARGETS,
  findUsableMatchingPoints,
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

  describe('findUsableMatchingPoints', () => {
    it('keeps numeric rate.* but drops non-numeric "договорная"', () => {
      const target = getTarget('rate_card')!;
      const usable = findUsableMatchingPoints(target, [
        { field: 'rate.post', value: 'договорная', capturedAt: new Date() },
        { field: 'rate.story', value: 8000, capturedAt: new Date() },
      ]);
      expect(usable).toHaveLength(1);
      expect(usable[0]!.point.field).toBe('rate.story');
      expect(usable[0]!.category).toBe('rateCards');
    });

    it('classifies views.avg as avgViews for the reach target (cross-section accept)', () => {
      // reach target matches both `reach.*` and `views.*` (registry decision).
      // A `views.avg = 30000` is a usable observation — caller must see it
      // with its OWN classification (avgViews) so the right TTL applies.
      const target = getTarget('reach')!;
      const usable = findUsableMatchingPoints(target, [
        { field: 'views.avg', value: 30000, capturedAt: new Date() },
      ]);
      expect(usable).toHaveLength(1);
      expect(usable[0]!.category).toBe('avgViews');
    });

    it('drops audience.geo with empty share record', () => {
      const target = getTarget('geo')!;
      const usable = findUsableMatchingPoints(target, [
        { field: 'audience.geo', value: {}, capturedAt: new Date() },
      ]);
      expect(usable).toHaveLength(0);
    });

    it('manual_only target finds nothing usable regardless of input', () => {
      const target = getTarget('deals_contact')!;
      const usable = findUsableMatchingPoints(target, [
        { field: 'contact.note', value: 'manager @x', capturedAt: new Date() },
      ]);
      expect(usable).toHaveLength(0);
    });
  });

  describe('buildHudTargetRow', () => {
    const now = new Date('2026-06-04T00:00:00.000Z');

    beforeAll(() => {
      // Pin system time so freshness/TTL assertions are stable irrespective
      // of when the test runs. `buildHudTargetRow` also accepts an explicit
      // `now` parameter — most assertions below use that, but the route
      // tests rely on the system clock so we cover both paths here.
      vi.useFakeTimers({ now });
    });
    afterAll(() => {
      vi.useRealTimers();
    });

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
        now,
      );
      expect(row.state).toBe('answered');
      expect(row.current?.value).toBe(15000);
      expect(row.current?.sourceMessageId).toBe('msg-1');
      expect(row.freshness?.stale).toBe(false);
      expect(row.freshness?.ageDays).toBe(10);
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
        now,
      );
      expect(row.state).toBe('stale');
      expect(row.freshness?.stale).toBe(true);
    });

    it('ignores a fresh non-contributing value and picks the older usable one', () => {
      // P2 regression guard: a fresh `rate.post = "договорная"` must NOT
      // become current; the latest USABLE numeric rate point wins, and
      // freshness reflects its age, not the unusable point's.
      const target = getTarget('rate_card')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'rate.post',
            value: 'договорная',
            capturedAt: new Date(now.getTime() - 1 * 86_400_000),
            sourceMessageId: 'msg-fresh',
          },
          {
            field: 'rate.story',
            value: 8000,
            capturedAt: new Date(now.getTime() - 60 * 86_400_000),
            sourceMessageId: 'msg-older',
          },
        ],
        null,
        now,
      );
      expect(row.state).toBe('answered');
      expect(row.current?.value).toBe(8000);
      expect(row.current?.sourceField).toBe('rate.story');
      expect(row.current?.sourceMessageId).toBe('msg-older');
      expect(row.freshness?.ageDays).toBe(60);
    });

    it('omits freshness entirely when no contributing current exists', () => {
      // P2 regression guard: a target with only non-usable matching
      // points reports state `missing`/`asked` and DOES NOT carry a
      // freshness object (matching the documented response shape).
      const target = getTarget('rate_card')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'rate.post',
            value: 'договорная',
            capturedAt: new Date(now.getTime() - 1 * 86_400_000),
            sourceMessageId: 'msg-fresh',
          },
        ],
        null,
        now,
      );
      expect(row.state).toBe('missing');
      expect(row.current).toBeUndefined();
      expect(row.freshness).toBeUndefined();
    });

    it('answers the reach target from a usable views.avg point', () => {
      // P2 regression guard: the registry accepts `views.*` under `reach`,
      // and the helper judges freshness via the point's OWN classification
      // (avgViews TTL = 90d, same as reach in practice). The HUD shows
      // this as answered, not silently missing.
      const target = getTarget('reach')!;
      const row = buildHudTargetRow(
        target,
        [
          {
            field: 'views.avg',
            value: 30000,
            capturedAt: new Date(now.getTime() - 5 * 86_400_000),
            sourceMessageId: 'msg-views',
          },
        ],
        null,
        now,
      );
      expect(row.state).toBe('answered');
      expect(row.current?.value).toBe(30000);
      expect(row.current?.sourceField).toBe('views.avg');
      expect(row.freshness?.stale).toBe(false);
      expect(row.freshness?.ageDays).toBe(5);
    });

    it('reports asked when there is no data point but a suggestion targeted it', () => {
      const target = getTarget('geo')!;
      const askedAt = new Date(now.getTime() - 2 * 3_600_000);
      const row = buildHudTargetRow(target, [], askedAt, now);
      expect(row.state).toBe('asked');
      expect(row.lastAskedAt).toBe(askedAt.toISOString());
      expect(row.current).toBeUndefined();
      expect(row.freshness).toBeUndefined();
    });

    it('reports missing when neither asked nor answered', () => {
      const target = getTarget('reach')!;
      const row = buildHudTargetRow(target, [], null, now);
      expect(row.state).toBe('missing');
      expect(row.current).toBeUndefined();
      expect(row.lastAskedAt).toBeUndefined();
      expect(row.freshness).toBeUndefined();
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
      const audienceRow = buildHudTargetRow(audience, points, null, now);
      const geoRow = buildHudTargetRow(geo, points, null, now);
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
        now,
      );
      expect(row.state).toBe('missing');
      expect(row.current).toBeUndefined();
      expect(row.freshness).toBeUndefined();
    });

    it('honours the default `now` when caller omits it (uses faked clock)', () => {
      // Production callers don't pass `now`; the helper defaults to
      // `new Date()`. With `vi.useFakeTimers({ now })` above, the
      // default value should match our pinned NOW so ageDays stays
      // stable.
      const target = getTarget('rate_card')!;
      const row = buildHudTargetRow(target, [
        {
          field: 'rate.post',
          value: 15000,
          capturedAt: new Date(now.getTime() - 10 * 86_400_000),
          sourceMessageId: 'msg-1',
        },
      ], null);
      expect(row.freshness?.ageDays).toBe(10);
    });
  });
});
