import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bloggerProfilesService } from '../services/blogger-profiles.js';
import { requireFeature } from '../require-feature.js';

/**
 * Blogger commercial profile read endpoints (agency-sourcing-matching M5,
 * task 5.4). Gated at request time by the `agency_sourcing` runtime flag.
 * Read access for admin/operator/viewer.
 */
export async function bloggerProfilesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('agency_sourcing'));
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/blogger-profiles',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          campaignId: z.string().optional(),
          briefId: z.string().optional(),
        })
        .parse(req.query);
      return bloggerProfilesService.list(q);
    },
  );

  app.get(
    '/blogger-profiles/:id',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      return bloggerProfilesService.get(params.id);
    },
  );

  app.post(
    '/blogger-profiles/:id/post-insights/refresh',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const out = await bloggerProfilesService.requestPostInsightRefresh(params.id);
      reply.code(out.postInsightRefreshStatus === 'pending' ? 202 : 200);
      return out;
    },
  );
}
