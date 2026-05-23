import { z } from 'zod';

/**
 * Capability → model map (agency-sourcing-matching change, milestone 3).
 *
 * The CampaignTypeBuilder picks a *tier* per pipeline role (cheap / medium /
 * strong) rather than a hardcoded model name. A capability map resolves a
 * tier to a concrete `{ provider, model }` pick; the builder then binds it to
 * an actual `endpoint` row of the matching provider that is configured in
 * this deployment. When no endpoint exists for a tier's provider the builder
 * MUST report the gap rather than emit an unusable reference (spec scenario
 * "Builder selects models by tier, not hardcoded names").
 *
 * Keys mirror `LLMProviderKind`. The map is seeded (per provider) so an
 * operator can later override it; the defaults below match the model ids the
 * agent seeds already use, so a fresh deploy degrades predictably.
 */

export const ModelTierZ = z.enum(['cheap', 'medium', 'strong']);
export type ModelTier = z.infer<typeof ModelTierZ>;

export const CapabilityProviderZ = z.enum(['yandex', 'openrouter', 'openai_compat']);
export type CapabilityProvider = z.infer<typeof CapabilityProviderZ>;

/** One tier → model pick for a given provider. */
export const CapabilityPickZ = z.object({
  provider: CapabilityProviderZ,
  model: z.string().min(1),
});
export type CapabilityPick = z.infer<typeof CapabilityPickZ>;

/** Full map: provider → tier → model id. */
export const CapabilityMapZ = z.record(
  CapabilityProviderZ,
  z.record(ModelTierZ, z.string().min(1)),
);
export type CapabilityMap = z.infer<typeof CapabilityMapZ>;

/**
 * Default capability map. Model ids match `agents.seed.ts` so the builder's
 * picks are consistent with how the built-in agents are wired. OpenRouter is
 * the richest tier ladder; Yandex covers cheap/medium/strong with its own
 * catalog; openai_compat is a generic placeholder a self-hosted gateway can
 * remap via the seeded `capability_map` rows.
 */
export const DEFAULT_CAPABILITY_MAP: CapabilityMap = {
  openrouter: {
    cheap: 'google/gemini-2.5-flash-lite',
    medium: 'google/gemini-3-flash-preview',
    strong: 'anthropic/claude-sonnet-4.6',
  },
  yandex: {
    cheap: 'yandexgpt-lite/latest',
    medium: 'yandexgpt/latest',
    strong: 'yandexgpt/rc',
  },
  openai_compat: {
    cheap: 'gpt-4o-mini',
    medium: 'gpt-4o',
    strong: 'gpt-4o',
  },
};

/**
 * Minimal endpoint shape the resolver needs. Decoupled from Prisma so this
 * stays usable in the shared package and in unit tests.
 */
export interface AvailableEndpoint {
  id: string;
  provider: CapabilityProvider | string;
  enabled: boolean;
}

/** Resolution of a single tier against the configured endpoints. */
export interface TierResolution {
  tier: ModelTier;
  /** null when no enabled endpoint exists for any provider that maps the tier. */
  endpointId: string | null;
  provider: CapabilityProvider | null;
  model: string | null;
  available: boolean;
}

/**
 * Resolve every tier against the endpoints actually configured in this
 * deployment, using `map` (defaults to {@link DEFAULT_CAPABILITY_MAP}).
 *
 * For each tier we look for an enabled endpoint whose provider has a model
 * mapped for that tier, preferring the order endpoints are passed in (the
 * seed/service passes them ordered by creation, so the operator's first
 * endpoint wins). A tier with no matching enabled endpoint resolves to
 * `available: false` with null fields — the builder reports it rather than
 * emitting an unusable reference (spec: degrade gracefully).
 */
export function resolveCapabilityMap(
  endpoints: AvailableEndpoint[],
  map: CapabilityMap = DEFAULT_CAPABILITY_MAP,
): Record<ModelTier, TierResolution> {
  const tiers: ModelTier[] = ['cheap', 'medium', 'strong'];
  const out = {} as Record<ModelTier, TierResolution>;
  for (const tier of tiers) {
    let resolved: TierResolution = {
      tier,
      endpointId: null,
      provider: null,
      model: null,
      available: false,
    };
    for (const ep of endpoints) {
      if (!ep.enabled) continue;
      const providerMap = map[ep.provider as CapabilityProvider];
      const model = providerMap?.[tier];
      if (model) {
        resolved = {
          tier,
          endpointId: ep.id,
          provider: ep.provider as CapabilityProvider,
          model,
          available: true,
        };
        break;
      }
    }
    out[tier] = resolved;
  }
  return out;
}

/** Tier the builder assigns to each pipeline role (see AGENTS.md "Дефолтные модели"). */
export const ROLE_TIER: Record<string, ModelTier> = {
  opening_composer: 'strong',
  approach_strategist: 'medium',
  reply_composer: 'strong',
  intent_classifier: 'cheap',
  safety_filter: 'cheap',
  handoff_decider: 'cheap',
  goal_fit_evaluator: 'cheap',
  conversation_summarizer: 'medium',
  next_action_planner: 'medium',
  data_collection_planner: 'medium',
  rate_card_extractor: 'medium',
  audience_stats_extractor: 'medium',
};
