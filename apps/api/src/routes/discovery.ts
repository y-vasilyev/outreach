import type { FastifyInstance } from 'fastify';
import { DiscoverySearchInputZ } from '@nosquare/shared';

import { discoveryService } from '../services/discovery.js';
import { auditService } from '../services/audit.js';
import { requireFeature } from '../require-feature.js';

/**
 * Channel discovery endpoint (channel-discovery-search change). Registered
 * unconditionally and gated at request time by the `channel_discovery`
 * runtime flag (404 when off) + admin/operator role. Audited.
 */
export async function discoveryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('channel_discovery'));
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/discovery/search',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const body = DiscoverySearchInputZ.parse(req.body);
      const userId = (req.user as { id: string }).id;
      const result = await discoveryService.search(body, userId);
      await auditService.log({
        userId,
        action: 'discovery.search',
        targetType: 'discovery',
        payload: { query: body.query, created: result.created, alreadyKnown: result.alreadyKnown },
      });
      return result;
    },
  );
}
