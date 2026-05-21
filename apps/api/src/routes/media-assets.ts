import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MediaAssetKindZ } from '@nosquare/shared';
import { mediaAssetsService } from '../services/media-assets.js';
import { requireFeature } from '../require-feature.js';

/**
 * Presigned media-asset endpoints (agency-sourcing-matching M6, task 6.4).
 * Gated at request time by the `object_storage` runtime flag. Access for
 * admin/operator. The UI fetches/uploads assets only via these short-lived
 * presigned URLs; bucket credentials are never returned or logged.
 */
export async function mediaAssetsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('object_storage'));
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/media-assets/:id/download-url',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const q = z
        .object({ ttl: z.coerce.number().int().min(30).max(3600).optional() })
        .parse(req.query);
      return mediaAssetsService.downloadUrl(params.id, q.ttl);
    },
  );

  app.post(
    '/media-assets/upload-url',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const body = z
        .object({
          conversationId: z.string().nullable().optional(),
          profileId: z.string().nullable().optional(),
          kind: MediaAssetKindZ,
          mime: z.string().nullable().optional(),
          ttl: z.number().int().min(30).max(3600).optional(),
        })
        .parse(req.body);
      const { ttl, ...input } = body;
      return mediaAssetsService.uploadUrl(input, ttl);
    },
  );
}
