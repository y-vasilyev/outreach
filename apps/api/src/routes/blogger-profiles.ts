import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CatalogOfferFiltersZ } from '@nosquare/shared';
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
        // Offer-level SQL filters + sort (catalog-sql-search): platform, kind,
        // duration, priceRubMax, cpmRubMax, offerFreshDays, hasOffers, sort.
        .merge(CatalogOfferFiltersZ)
        .parse(req.query);
      return bloggerProfilesService.list(q);
    },
  );

  app.get(
    '/blogger-profiles/:id',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const q = z
        .object({
          includeSuperseded: z
            .preprocess((v) => (v === 'true' || v === true ? true : v === 'false' ? false : v), z.boolean())
            .optional(),
          // Fit-verdict context (decision-ux): mutually exclusive, validated
          // in the service.
          campaignId: z.string().optional(),
          briefId: z.string().optional(),
        })
        .parse(req.query ?? {});
      return bloggerProfilesService.get(params.id, {
        includeSuperseded: q.includeSuperseded ?? false,
        campaignId: q.campaignId,
        briefId: q.briefId,
      });
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

  // Post-example image URL (blogger-profile-who-is-this). YouTube → the public
  // thumbnail URL directly; Telegram → a presigned S3 GET when the photo is
  // stored, else 409 (the public re-fetch downloader is a follow-up). 404 when
  // the insight is missing; 409 when unsupported / no image / storage off.
  app.get(
    '/blogger-post-insights/:id/image-url',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return bloggerProfilesService.postInsightImageUrl(id);
    },
  );
}
