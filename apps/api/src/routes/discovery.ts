import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DiscoverySearchInputZ, DiscoveryBatchInputZ } from '@nosquare/shared';

import { discoveryService } from '../services/discovery.js';
import { discoveryBatchService } from '../services/discovery-batch.js';
import { auditService } from '../services/audit.js';
import { requireFeature } from '../require-feature.js';

/**
 * Channel discovery endpoints (channel-discovery-search +
 * batch-channel-discovery changes). All discovery routes are registered
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

  app.post(
    '/discovery/batch',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const body = DiscoveryBatchInputZ.parse(req.body);
      const userId = (req.user as { id: string }).id;
      const { id } = await discoveryBatchService.create(body, userId);
      await auditService.log({
        userId,
        action: 'discovery.batch.create',
        targetType: 'discovery_batch',
        targetId: id,
        payload: { queries: body.queries.length, platform: body.platform ?? null },
      });
      return { id };
    },
  );

  app.get(
    '/discovery/batch',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async () => discoveryBatchService.list(),
  );

  app.get(
    '/discovery/batch/:id',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      return discoveryBatchService.get(params.id);
    },
  );
}
