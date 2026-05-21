import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from '@nosquare/shared';

import { featureFlagsService } from '../services/feature-flags.js';
import { auditService } from '../services/audit.js';
import { publishFeatureFlagsChanged } from '../feature-flags.js';

/**
 * Admin control plane for runtime feature flags (runtime-feature-flags M3).
 *
 * Registered UNCONDITIONALLY (not behind `requireFeature`) — this is the only
 * place flags are toggled, so it must always be reachable by admins regardless
 * of any flag's state. Reads are admin-only too; the public, secret-free
 * snapshot the web consumes lives at `GET /config`.
 *
 * A toggle: validates the key against the closed registry + body via zod,
 * updates the row (recording the actor), writes an `audit_log` entry, then
 * publishes a cross-process invalidation so api + workers refresh without a
 * restart.
 */

const FlagKeyZ = z.enum(FEATURE_FLAG_KEYS as [FeatureFlagKey, ...FeatureFlagKey[]]);
const ToggleBodyZ = z.object({ enabled: z.boolean() });

export async function featureFlagsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/feature-flags',
    { preHandler: [app.requireRole(['admin'])] },
    async () => featureFlagsService.list(),
  );

  app.patch(
    '/feature-flags/:key',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const { key } = z.object({ key: FlagKeyZ }).parse(req.params);
      const { enabled } = ToggleBodyZ.parse(req.body);
      const userId = (req.user as { id: string }).id;

      const updated = await featureFlagsService.setEnabled(key, enabled, userId);

      await auditService.log({
        userId,
        action: 'feature_flag.update',
        targetType: 'feature_flag',
        targetId: key,
        payload: { enabled },
      });

      // Refresh this process's cache and notify api + workers.
      await publishFeatureFlagsChanged();

      return {
        key: updated.key as FeatureFlagKey,
        enabled: updated.enabled,
        description: updated.description,
      };
    },
  );
}
