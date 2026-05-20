import { z } from 'zod';

import { ModelTierZ } from '../capability-map.js';
import {
  AgentSetZ,
  GoalSchemaZ,
  SafetyProfileZ,
  AutonomyPolicyZ,
} from './campaign-type.js';

/**
 * Campaign-type builder I/O (agency-sourcing-matching change, milestone 3).
 *
 * The builder is a meta-agent: it takes a plain-language goal and emits a
 * DRAFT campaign type + draft agent configs for each pipeline role. The draft
 * is reviewed by an operator and only becomes live `agent_config` rows on an
 * explicit save (Decision D3 — never auto-publish).
 */

export const BuildCampaignTypeInputZ = z.object({
  goal_description: z.string().min(1),
  examples: z.array(z.string()).optional(),
  constraints: z.record(z.unknown()).optional(),
});
export type BuildCampaignTypeInput = z.infer<typeof BuildCampaignTypeInputZ>;

/**
 * A single drafted agent config. Mirrors the editable fields of
 * `agent_config` plus the tier the builder chose. `endpointId`/`model`/
 * `provider` may be null when no endpoint exists for the chosen tier — in
 * that case `tierAvailable=false` and the agent is reported, not silently
 * emitted with a dangling reference.
 */
export const DraftAgentConfigZ = z.object({
  /** Pipeline role this agent fills (key in `agentSet`). */
  role: z.string().min(1),
  /** Proposed `agent_config.name` (unique). */
  name: z.string().min(1),
  description: z.string().default(''),
  tier: ModelTierZ,
  /** Resolved endpoint for the tier; null when no endpoint is available. */
  endpointId: z.string().nullable(),
  /** Provider of the resolved endpoint (for operator clarity). */
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** True when an endpoint exists for the chosen tier. */
  tierAvailable: z.boolean(),
  systemPrompt: z.string(),
  userPromptTemplate: z.string(),
  params: z.record(z.unknown()).default({}),
  /** Output JSON-schema where the role produces structured output. */
  outputJsonSchema: z.record(z.unknown()).nullable().default(null),
});
export type DraftAgentConfig = z.infer<typeof DraftAgentConfigZ>;

/** Per-agent dry-run result attached after fixtures run (3.3). */
export const DraftAgentTestResultZ = z.object({
  role: z.string(),
  name: z.string(),
  /** Skipped when the tier had no endpoint — `skippedReason` explains. */
  ran: z.boolean(),
  skippedReason: z.string().nullable().default(null),
  output: z.unknown().optional(),
  tokensIn: z.number().default(0),
  tokensOut: z.number().default(0),
  costUsd: z.number().default(0),
  latencyMs: z.number().default(0),
  error: z.string().nullable().default(null),
});
export type DraftAgentTestResult = z.infer<typeof DraftAgentTestResultZ>;

/** The complete draft returned to the operator for review. */
export const CampaignTypeDraftZ = z.object({
  /** Opaque id for fetching this draft's results before save. */
  draftId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().default(''),
  goalSchema: GoalSchemaZ,
  safetyProfile: SafetyProfileZ,
  autonomyPolicy: AutonomyPolicyZ,
  agentSet: AgentSetZ,
  agents: z.array(DraftAgentConfigZ),
  testResults: z.array(DraftAgentTestResultZ).default([]),
  /** Tiers with no configured endpoint, reported instead of emitting a bad ref. */
  unavailableTiers: z.array(ModelTierZ).default([]),
});
export type CampaignTypeDraft = z.infer<typeof CampaignTypeDraftZ>;

/** Save-draft request: the reviewed (optionally edited) draft. */
export const SaveCampaignTypeDraftInputZ = z.object({
  draft: CampaignTypeDraftZ,
});
export type SaveCampaignTypeDraftInput = z.infer<typeof SaveCampaignTypeDraftInputZ>;
