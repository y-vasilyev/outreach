import { z } from 'zod';
import { CampaignModeZ } from './campaign.js';

/**
 * Campaign type registry (agency-sourcing-matching change).
 *
 * A campaign type is the configurable dictionary entry that drives the
 * outreach/inbound pipelines: which agents run, the safety profile, the
 * autonomy policy, and the JSON-schema a campaign's `goal` is validated
 * against. CustDev and agency-sourcing are seeded built-in types; the
 * builder authors more.
 */

/**
 * Per-pipeline-role slot: which agent (by `agent_config.name`) fills the
 * role, plus optional per-type config overrides merged over the global
 * agent config (same shape as `campaign.agentOverrides`).
 */
export const AgentSlotZ = z.object({
  agentName: z.string().min(1),
  overrides: z.record(z.unknown()).default({}),
});

/**
 * The pipeline roles the runtime knows how to consume. `AgentSetZ` is an
 * intentionally OPEN record (not keyed by this enum) so the builder can
 * author types with extra/forward-looking roles without a schema bump;
 * unknown keys are simply ignored by pipelines that don't look them up.
 * This enum documents the consumed set and powers UI dropdowns.
 */
export const PipelineRoleZ = z.enum([
  'opening_composer',
  'approach_strategist',
  'reply_composer',
  'intent_classifier',
  'safety_filter',
  'handoff_decider',
  'goal_fit_evaluator',
  'conversation_summarizer',
  'next_action_planner',
  'data_collection_planner',
  'rate_card_extractor',
  'audience_stats_extractor',
]);

/** Map of pipeline-role → agent slot. */
export const AgentSetZ = z.record(AgentSlotZ).default({});

/**
 * One deterministic hard-block pattern. SafetyFilter rejects any draft
 * whose text matches at least one of these BEFORE invoking its LLM
 * scoring step. `pattern` is compiled to a JS `RegExp` with `flags`; both
 * are length- and content-bounded so an admin (or a malformed builder
 * output) can't ReDoS the worker.
 */
export const HardBlockPatternZ = z.object({
  /** Stable identifier (logged + used in `reasons[]`). */
  id: z.string().min(1).max(80),
  /** Regex source. Bounded length to keep ReDoS risk low. */
  pattern: z.string().min(1).max(200),
  /** Short human-readable reason; surfaces in `rewrite_hint`. */
  reason: z.string().min(1).max(200),
  /** Allowed regex flags: case-insensitive / multiline / unicode. */
  flags: z
    .string()
    .max(8)
    .regex(/^[imu]*$/)
    .optional(),
});
export type HardBlockPattern = z.infer<typeof HardBlockPatternZ>;

/**
 * Shape of the base safety profile (everything except
 * `hard_block_patterns`). Factored out so `BaseSafetyProfileZ` and
 * `SafetyProfileZ` stay in lock-step — adding a new base field is one
 * edit, not two.
 */
const safetyProfileBaseShape = {
  forbidden_topics: z.array(z.string()).default([]),
  allowed_topics: z.array(z.string()).default([]),
  allow_links: z.boolean().default(false),
  max_length: z.number().int().min(50).max(5000).default(600),
} as const;

/**
 * Base safety profile (no `hard_block_patterns`). Exported so
 * `resolveSafetyContext` can validate the base shape independently and
 * keep a valid profile alive when a single `hard_block_patterns` entry
 * is malformed.
 */
export const BaseSafetyProfileZ = z
  .object(safetyProfileBaseShape)
  .passthrough()
  .default({});

/**
 * Safety profile read by SafetyFilter instead of global defaults. The
 * `custdev` type seeds the legacy forbidden vocabulary; `agency_sourcing`
 * permits commercial vocabulary.
 *
 * `forbidden_topics`/`allowed_topics` remain advisory tone signals.
 * `hard_block_patterns` are DETERMINISTIC blocks evaluated before the
 * LLM scoring step (see `SafetyFilter`); they exist so safety-critical
 * categories like "guarantees", "payment links", or "time-pressure
 * tactics" cannot slip through a stylistic LLM pass.
 */
export const SafetyProfileZ = z
  .object({
    ...safetyProfileBaseShape,
    hard_block_patterns: z.array(HardBlockPatternZ).default([]),
  })
  .passthrough()
  .default({});

/**
 * Autonomy policy: gate thresholds (mirrors auto-approve.ts env defaults)
 * and intents that force an immediate operator handoff for this type.
 */
export const AutonomyPolicyZ = z
  .object({
    defaultMode: CampaignModeZ.default('assisted'),
    T_safety: z.number().min(0).max(1).default(0.8),
    T_semi_auto_goalfit: z.number().min(0).max(1).default(0.6),
    T_auto_goalfit: z.number().min(0).max(1).default(0.75),
    forceHandoffIntents: z.array(z.string()).default([]),
  })
  .passthrough()
  .default({});

/** A campaign-type goal schema is itself a JSON schema (kept opaque here). */
export const GoalSchemaZ = z.record(z.unknown()).default({});

export const CampaignTypeZ = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().default(''),
  goalSchema: GoalSchemaZ,
  agentSet: AgentSetZ,
  safetyProfile: SafetyProfileZ,
  autonomyPolicy: AutonomyPolicyZ,
  builtIn: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateCampaignTypeInputZ = z.object({
  // kebab/snake key; built-in keys (`custdev`, `agency_sourcing`) are reserved.
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, 'key must be snake_case'),
  name: z.string().min(1),
  description: z.string().default(''),
  goalSchema: GoalSchemaZ,
  agentSet: AgentSetZ,
  safetyProfile: SafetyProfileZ,
  autonomyPolicy: AutonomyPolicyZ,
  enabled: z.boolean().default(true),
});

export const UpdateCampaignTypeInputZ = CreateCampaignTypeInputZ.partial().extend({
  id: z.string(),
});

export type AgentSlot = z.infer<typeof AgentSlotZ>;
export type AgentSet = z.infer<typeof AgentSetZ>;
export type SafetyProfile = z.infer<typeof SafetyProfileZ>;
export type AutonomyPolicy = z.infer<typeof AutonomyPolicyZ>;
export type CampaignType = z.infer<typeof CampaignTypeZ>;
export type CreateCampaignTypeInput = z.infer<typeof CreateCampaignTypeInputZ>;
export type UpdateCampaignTypeInput = z.infer<typeof UpdateCampaignTypeInputZ>;

/** Reserved built-in keys that the API must not let clients overwrite. */
export const BUILTIN_CAMPAIGN_TYPE_KEYS = ['custdev', 'agency_sourcing'] as const;
