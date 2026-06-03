import { resolveSafetyContext } from './campaign-type-resolve.js';

/**
 * Build the SafetyFilter input + AgentRunner overrides from a campaign's
 * stored safety profile. Single source of truth so dispatcher, agent-run
 * inbound reply, agent-run first-message, operator approve, and direct-send
 * all pass IDENTICAL safety context to `SafetyFilter` — see
 * `campaign-type-registry` capability, "SafetyFilter input parity".
 *
 * Behaviour:
 *   - When `safetyProfile` is null/undefined OR `campaignTypesEnabled === false`,
 *     returns the legacy shape `{ input: base, overrides: undefined }` — no
 *     topic lists, no hard blocks, no max-length/allow-links overrides. This
 *     keeps the CustDev / flag-off path byte-for-byte the pre-registry path.
 *   - When a profile is supplied, returns the full input + ctx overrides
 *     derived via `resolveSafetyContext`. Malformed entries are dropped by
 *     the resolver, never thrown.
 *
 * `base` carries the call-site-specific fields (draft, channel_analysis,
 * contact, campaign blocks) so the helper can produce one self-contained
 * input object that the caller can pass straight into `runner.run` /
 * `runAgentSafe`.
 */
export interface BuildSafetyInputArgs {
  /** The draft text being checked. */
  draft: string;
  /** Whether the campaign-types runtime flag is on (caller decides). */
  campaignTypesEnabled: boolean;
  /** Raw campaign-type safety profile (`campaign.type.safetyProfile`); null when no type. */
  safetyProfile?: unknown;
  /** Identifying fields the SafetyFilter prompt benefits from. */
  channelAnalysis?: unknown;
  contact?: Record<string, unknown>;
  campaign?: Record<string, unknown>;
  /** AJTBD non_goals fed into the LLM tone check, when available. */
  ajtbdNonGoals?: string[];
}

export interface SafetyFilterInputBundle {
  input: Record<string, unknown>;
  /** AgentRunner ctx overrides (max_length / allow_links). Undefined ⇒ legacy defaults. */
  overrides?: { params: { max_length: number; allow_links: boolean } };
}

export function buildSafetyInput(args: BuildSafetyInputArgs): SafetyFilterInputBundle {
  const base: Record<string, unknown> = { draft: args.draft };
  if (args.channelAnalysis !== undefined) base.channel_analysis = args.channelAnalysis;
  if (args.contact !== undefined) base.contact = args.contact;
  if (args.campaign !== undefined) base.campaign = args.campaign;
  if (args.ajtbdNonGoals && args.ajtbdNonGoals.length > 0) {
    base.ajtbd_non_goals = args.ajtbdNonGoals;
  }

  if (!args.campaignTypesEnabled || args.safetyProfile == null) {
    return { input: base };
  }

  const ctx = resolveSafetyContext(args.safetyProfile);
  const hardBlocks = ctx.hard_block_patterns.map((p) => ({
    id: p.id,
    pattern: p.regex.source,
    reason: p.reason,
    ...(p.regex.flags ? { flags: p.regex.flags } : {}),
  }));
  return {
    input: {
      ...base,
      forbidden_topics: ctx.forbidden_topics,
      allowed_topics: ctx.allowed_topics,
      hard_block_patterns: hardBlocks,
    },
    overrides: { params: ctx.params },
  };
}
