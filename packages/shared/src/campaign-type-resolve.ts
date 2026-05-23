import {
  BaseSafetyProfileZ,
  AutonomyPolicyZ,
  AgentSetZ,
  HardBlockPatternZ,
  type HardBlockPattern,
} from './schemas/campaign-type.js';

/**
 * Pure resolution helpers for campaign-type-driven pipeline behavior
 * (agency-sourcing-matching change). Kept free of feature-flag and DB
 * concerns so they are trivially unit-testable; the worker decides
 * (behind `ENABLE_CAMPAIGN_TYPES`) whether to feed a real type profile or
 * fall back to the legacy default.
 */

/**
 * A single hard-block pattern with its source already compiled to a
 * RegExp. Resolver does the compile + validation; downstream consumers
 * (SafetyFilter, worker queue serialization) read this shape.
 */
export interface ResolvedHardBlockPattern {
  id: string;
  reason: string;
  regex: RegExp;
}

export interface ResolvedSafetyContext {
  /** Hard-guard params forwarded to SafetyFilter via agent overrides. */
  params: { max_length: number; allow_links: boolean };
  /** Advisory tone lists fed into SafetyFilter's input. */
  forbidden_topics: string[];
  allowed_topics: string[];
  /** Deterministic hard-block patterns evaluated before the LLM scoring. */
  hard_block_patterns: ResolvedHardBlockPattern[];
}

/**
 * The behavior before campaign types existed: 600-char cap, no links, no
 * topic lists, no hard-block patterns. Used for ad-hoc conversations, for
 * any campaign without a type, and whenever the flag is off — so enabling
 * the registry is a no-op until a type actually carries a profile.
 */
export const LEGACY_SAFETY_CONTEXT: ResolvedSafetyContext = {
  params: { max_length: 600, allow_links: false },
  forbidden_topics: [],
  allowed_topics: [],
  hard_block_patterns: [],
};

/**
 * Compile a single stored `HardBlockPattern` into a RegExp + metadata.
 * Returns `null` (and only `null`) when the regex source/flags don't
 * compile — caller treats that as "skip this entry" without throwing.
 */
function compileHardBlockPattern(
  p: HardBlockPattern,
): ResolvedHardBlockPattern | null {
  try {
    return { id: p.id, reason: p.reason, regex: new RegExp(p.pattern, p.flags) };
  } catch {
    return null;
  }
}

// `BaseSafetyProfileZ` from the campaign-type schemas is the base shape
// (no `hard_block_patterns`). Parsing it independently is the trick that
// lets a single malformed pattern be dropped item-by-item without
// blowing away the rest of the safety profile.

/**
 * Map a campaign type's stored `safetyProfile` JSON into a safety context.
 *
 * Robust to partially-malformed input: the base profile fields and each
 * `hard_block_patterns` entry are validated independently, so a single
 * bad pattern (wrong `id` length, missing field, illegal flags, etc.)
 * is skipped without losing the rest of the profile.
 */
export function resolveSafetyContext(
  rawSafetyProfile: unknown,
): ResolvedSafetyContext {
  if (rawSafetyProfile == null) return LEGACY_SAFETY_CONTEXT;

  // Parse the base shape (everything except `hard_block_patterns`). If
  // even that fails — the JSON is structurally wrong — fall back to
  // legacy.
  const base = BaseSafetyProfileZ.safeParse(rawSafetyProfile);
  if (!base.success) return LEGACY_SAFETY_CONTEXT;

  // Iterate the raw `hard_block_patterns` list (if present) item-by-item.
  // Each item is independently safeParsed against `HardBlockPatternZ`,
  // then independently compiled to a RegExp — a single bad apple does
  // not invalidate the whole basket.
  const hardBlocks: ResolvedHardBlockPattern[] = [];
  const rawList =
    typeof rawSafetyProfile === 'object' && rawSafetyProfile !== null
      ? (rawSafetyProfile as { hard_block_patterns?: unknown }).hard_block_patterns
      : undefined;
  if (Array.isArray(rawList)) {
    for (const raw of rawList) {
      const parsed = HardBlockPatternZ.safeParse(raw);
      if (!parsed.success) continue;
      const compiled = compileHardBlockPattern(parsed.data);
      if (compiled) hardBlocks.push(compiled);
    }
  }
  // Malformed entries are silently dropped at the resolver layer. The
  // SafetyFilter agent does its own per-pattern try/catch as a second
  // line of defense for callers that pass the raw wire shape directly
  // (e.g. tests, ad-hoc invocations).

  return {
    params: { max_length: base.data.max_length, allow_links: base.data.allow_links },
    forbidden_topics: base.data.forbidden_topics,
    allowed_topics: base.data.allowed_topics,
    hard_block_patterns: hardBlocks,
  };
}

/**
 * Intents that the campaign type wants escalated to the operator
 * immediately (e.g. agency price/quote intents). Empty for a missing or
 * invalid policy, so the existing HandoffDecider logic stands alone.
 */
export function resolveForceHandoffIntents(rawPolicy: unknown): string[] {
  if (rawPolicy == null) return [];
  const parsed = AutonomyPolicyZ.safeParse(rawPolicy);
  return parsed.success ? parsed.data.forceHandoffIntents : [];
}

/**
 * Resolve which `agent_config.name` fills a pipeline role for a campaign
 * type, given the type's stored `agentSet` JSON. Pure so the worker can wire
 * it up behind `ENABLE_CAMPAIGN_TYPES` without reaching for the DB here.
 *
 * Falls back to `fallback` (typically the role name itself, which equals the
 * legacy global agent name — e.g. `opening_composer`) when the role is absent
 * or the agentSet is missing/invalid. This keeps a flag-off / typeless
 * campaign on the legacy agent set.
 *
 * The agency type maps `opening_composer → agency_opening_composer` and adds
 * `data_collection_planner`, so once the worker call-site is wired, agency
 * conversations resolve the agency-framed agents while CustDev stays put.
 */
export function resolveAgentName(
  rawAgentSet: unknown,
  role: string,
  fallback: string,
): string {
  if (rawAgentSet == null) return fallback;
  const parsed = AgentSetZ.safeParse(rawAgentSet);
  if (!parsed.success) return fallback;
  const slot = parsed.data[role];
  if (!slot || !slot.agentName) return fallback;
  return slot.agentName;
}
