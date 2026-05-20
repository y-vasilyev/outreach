import {
  SafetyProfileZ,
  AutonomyPolicyZ,
} from './schemas/campaign-type.js';

/**
 * Pure resolution helpers for campaign-type-driven pipeline behavior
 * (agency-sourcing-matching change). Kept free of feature-flag and DB
 * concerns so they are trivially unit-testable; the worker decides
 * (behind `ENABLE_CAMPAIGN_TYPES`) whether to feed a real type profile or
 * fall back to the legacy default.
 */

export interface ResolvedSafetyContext {
  /** Hard-guard params forwarded to SafetyFilter via agent overrides. */
  params: { max_length: number; allow_links: boolean };
  /** Advisory tone lists fed into SafetyFilter's input. */
  forbidden_topics: string[];
  allowed_topics: string[];
}

/**
 * The behavior before campaign types existed: 600-char cap, no links, no
 * topic lists. Used for ad-hoc conversations, for any campaign without a
 * type, and whenever the flag is off — so enabling the registry is a no-op
 * until a type actually carries a profile.
 */
export const LEGACY_SAFETY_CONTEXT: ResolvedSafetyContext = {
  params: { max_length: 600, allow_links: false },
  forbidden_topics: [],
  allowed_topics: [],
};

/** Map a campaign type's stored `safetyProfile` JSON into a safety context. */
export function resolveSafetyContext(
  rawSafetyProfile: unknown,
): ResolvedSafetyContext {
  if (rawSafetyProfile == null) return LEGACY_SAFETY_CONTEXT;
  const parsed = SafetyProfileZ.safeParse(rawSafetyProfile);
  if (!parsed.success) return LEGACY_SAFETY_CONTEXT;
  const sp = parsed.data;
  return {
    params: { max_length: sp.max_length, allow_links: sp.allow_links },
    forbidden_topics: sp.forbidden_topics,
    allowed_topics: sp.allowed_topics,
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
