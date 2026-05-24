import { z } from 'zod';

/**
 * Structured AJTBD framing for a campaign. After
 * `drop-campaign-ajtbd-column` the on-disk source is `Campaign.goal`
 * (for the `custdev` type whose goal_schema IS the AJTBD shape); a
 * `extractAjtbdView` helper bridges that to the historical
 * `CampaignAjtbd` input contract that ReplyComposer / HandoffDecider /
 * SafetyFilter / GoalFitEvaluator still consume on every inbound.
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

/** Type-key of the seeded CustDev campaign type — the only type whose
 * goal_schema mirrors the AJTBD shape. */
export const CUSTDEV_TYPE_KEY = 'custdev';

/**
 * Derive an AJTBD-shaped view from a campaign for agents (ReplyComposer,
 * HandoffDecider, GoalFitEvaluator) that historically consumed
 * `Campaign.ajtbd`. The on-disk source of truth is `Campaign.goal`,
 * disambiguated by the campaign's `type.key`:
 *
 * - For `custdev` campaigns, `goal` matches `CampaignAjtbdZ` (the
 *   custdev type's goal_schema). We safe-parse and pass it through, with
 *   a scaffold fallback for partially-filled or legacy rows where
 *   parsing fails.
 * - For any other type (agency_sourcing, builder-authored types) we
 *   ALWAYS fall back to a deterministic scaffold derived from
 *   `goalText` / `valueProp`. This avoids the ambiguity of
 *   `CampaignAjtbdZ.safeParse(...)` succeeding on a non-AJTBD goal
 *   simply because every AJTBD field has a Zod default — that path
 *   would silently collapse the agency goal into an empty-defaults
 *   AJTBD and lose semantic content.
 *
 * After the `drop-campaign-ajtbd-column` change, this helper is the only
 * place that knows how to bridge between `Campaign.goal` and the
 * historical `CampaignAjtbd` input contract.
 */
export function extractAjtbdView(campaign: {
  goal: unknown;
  goalText: string;
  valueProp: string;
  /**
   * Type key (`campaign_type.key`). When omitted or unknown the helper
   * is conservative and falls back to the scaffold; pass the real key
   * (`campaign.type?.key`) at runtime callsites so CustDev goals are
   * recognised.
   */
  typeKey?: string | null;
}): CampaignAjtbd {
  if (campaign.typeKey === CUSTDEV_TYPE_KEY && campaign.goal != null) {
    const parsed = CampaignAjtbdZ.safeParse(campaign.goal);
    if (parsed.success) return parsed.data;
    // CustDev rows whose goal can't be parsed (legacy or partial fills)
    // fall through to the scaffold so agents always see a well-formed
    // AJTBD.
  }
  return buildAjtbdScaffold({
    goalText: campaign.goalText,
    valueProp: campaign.valueProp,
  });
}
