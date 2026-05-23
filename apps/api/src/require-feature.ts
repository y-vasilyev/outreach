import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FeatureFlagKey } from '@nosquare/shared';

import { getFeatureFlags } from './feature-flags.js';

/**
 * preHandler that 404s when a runtime feature flag is off (runtime-feature-
 * flags). Routes for flag-gated capabilities are registered unconditionally
 * and composed with this before `requireRole`, so toggling the flag changes
 * availability without a restart.
 *
 * Uses `reply.callNotFound()` — the SAME plain 404 a truly unregistered route
 * would produce — so the web's `isFeatureOff` keeps distinguishing
 * "feature disabled" (plain 404) from a real entity NOT_FOUND (AppError).
 */
export function requireFeature(key: FeatureFlagKey) {
  return async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!getFeatureFlags().get(key)) {
      return reply.callNotFound();
    }
  };
}
