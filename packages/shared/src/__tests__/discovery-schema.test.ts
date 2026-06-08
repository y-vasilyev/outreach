import { describe, expect, it } from 'vitest';

import {
  CandidateActionZ,
  CandidateDecisionZ,
  GuidedRunStatusEnumZ,
  GuidedRunSummaryZ,
} from '../schemas/discovery.js';
import { GuidedDiscoveryReviewJobZ } from '../schemas/queue.js';

/**
 * Contract guarantees for the guided-discovery evidence loop
 * (fix-guided-discovery-evidence-loop). These pin the schema/service
 * agreement called out in tasks.md §1 + §6.7 so a later layer can rely on
 * them: `launch` carries an OPTIONAL `campaignId`, the run can sit in the
 * non-terminal `enriching` state, the summary exposes `pendingReview`, and the
 * `launched` decision is a valid terminal operator decision.
 */
describe('guided-discovery evidence-loop schemas', () => {
  it('CandidateActionZ accepts launch with an OPTIONAL campaignId', () => {
    // launch WITHOUT a campaignId is valid — the service resolves it from the
    // run (D7); the schema must NOT refine campaignId to required for launch.
    expect(CandidateActionZ.parse({ action: 'launch' })).toEqual({ action: 'launch' });
    expect(CandidateActionZ.parse({ action: 'launch', campaignId: 'camp_1' })).toEqual({
      action: 'launch',
      campaignId: 'camp_1',
    });
  });

  it('CandidateActionZ still accepts the prior actions', () => {
    for (const action of ['save', 'shortlist', 'reject', 'clear', 'scrape_refresh'] as const) {
      expect(CandidateActionZ.parse({ action }).action).toBe(action);
    }
  });

  it('CandidateActionZ rejects an unknown action', () => {
    expect(CandidateActionZ.safeParse({ action: 'nope' }).success).toBe(false);
  });

  it('GuidedRunStatusEnumZ accepts the non-terminal enriching state', () => {
    expect(GuidedRunStatusEnumZ.parse('enriching')).toBe('enriching');
    // still accepts the original terminal/initial states
    for (const s of ['pending', 'running', 'done', 'failed'] as const) {
      expect(GuidedRunStatusEnumZ.parse(s)).toBe(s);
    }
  });

  it('GuidedRunSummaryZ parses pendingReview and defaults it to 0', () => {
    // `budgets` has no default on the summary; supply an empty object so the
    // nested `GuidedRunBudgetsZ` defaults fill in.
    const parsed = GuidedRunSummaryZ.parse({ budgets: {} });
    expect(parsed.pendingReview).toBe(0);
    expect(GuidedRunSummaryZ.parse({ budgets: {}, pendingReview: 3 }).pendingReview).toBe(3);
  });

  it('CandidateDecisionZ accepts launched alongside the prior decisions', () => {
    for (const d of ['saved', 'shortlisted', 'rejected', 'launched'] as const) {
      expect(CandidateDecisionZ.parse(d)).toBe(d);
    }
  });

  it('GuidedDiscoveryReviewJobZ accepts a per-candidate job and a sweep job', () => {
    expect(
      GuidedDiscoveryReviewJobZ.parse({
        runId: 'run_1',
        candidateId: 'cand_1',
        scrapeOutcome: 'ok',
      }),
    ).toMatchObject({ runId: 'run_1', candidateId: 'cand_1', scrapeOutcome: 'ok' });

    // sweep job carries no candidateId
    expect(GuidedDiscoveryReviewJobZ.parse({ runId: 'run_1', sweep: true })).toMatchObject({
      runId: 'run_1',
      sweep: true,
    });

    // runId is required
    expect(GuidedDiscoveryReviewJobZ.safeParse({ candidateId: 'cand_1' }).success).toBe(false);
    // scrapeOutcome is constrained to ok|failed
    expect(
      GuidedDiscoveryReviewJobZ.safeParse({ runId: 'run_1', scrapeOutcome: 'maybe' }).success,
    ).toBe(false);
  });
});
