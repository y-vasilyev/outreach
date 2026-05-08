import { z } from 'zod';

/**
 * Structured AJTBD framing for a campaign. Stored as JSON on
 * `Campaign.ajtbd` and fed into ReplyComposer / HandoffDecider /
 * SafetyFilter / GoalFitEvaluator on every inbound.
 *
 * Why JSON over a normalized table: AJTBD is one record per campaign,
 * mostly read together, evolves often (the prompt copy in agents
 * iterates faster than the table schema would). A zod schema keeps it
 * type-safe at the API boundary and at agent-input time.
 *
 * Empty arrays are valid — the operator may fill them in later via the
 * admin UI. Missing keys (e.g. an old payload predating an added
 * `forces.habits`) are not — clients must send a complete object.
 */
export const CampaignAjtbdForcesZ = z.object({
  push: z.array(z.string()).default([]),
  pull: z.array(z.string()).default([]),
  anxieties: z.array(z.string()).default([]),
  habits: z.array(z.string()).default([]),
});

export const CampaignAjtbdZ = z.object({
  job: z.string().default(''),
  when: z.string().default(''),
  forces: CampaignAjtbdForcesZ.default({}),
  desired_outcome: z.string().default(''),
  non_goals: z.array(z.string()).default([]),
});

export type CampaignAjtbd = z.infer<typeof CampaignAjtbdZ>;

/**
 * Latest GoalFitEvaluator decision persisted on `Conversation.qualityDecision`.
 * See packages/agents/src/agents/GoalFitEvaluator.ts for action semantics.
 */
export const QualityDecisionZ = z.object({
  score: z.number().min(0).max(1),
  action: z.enum(['continue', 'soften', 'handoff_silent']),
  reasons: z.array(z.string()).default([]),
  agentRunId: z.string().optional(),
  decidedAt: z.string(),
});

export type QualityDecision = z.infer<typeof QualityDecisionZ>;

/**
 * Build a default AJTBD scaffold from a campaign's goalText / valueProp.
 * Used by API code paths that need to seed an AJTBD when an admin
 * creates a campaign without filling it in. The migration applies the
 * same shape to existing rows.
 */
export function buildAjtbdScaffold(opts: {
  goalText: string;
  valueProp: string;
}): CampaignAjtbd {
  return {
    job: opts.goalText,
    when: '',
    forces: { push: [], pull: [], anxieties: [], habits: [] },
    desired_outcome: opts.valueProp,
    non_goals: [],
  };
}
