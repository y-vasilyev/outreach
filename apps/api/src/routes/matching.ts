import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateAdBriefInputZ } from '@nosquare/shared';
import { matchingService } from '../services/matching.js';
import { auditService } from '../services/audit.js';

/**
 * Ad-brief intake + blogger matching endpoints (agency-sourcing-matching M7,
 * tasks 7.1/7.5). Registered behind ENABLE_BLOGGER_MATCHING — a no-op when the
 * flag is off. Roles: admin/operator.
 *
 * Matching defaults to the deterministic path. The LLM re-rank (bounded to the
 * top N) only runs when the caller opts in via `?rerank=true` (or `rerank` in
 * the body), keeping cost contained and the path deterministic by default.
 */
const matchOptsZ = z.object({
  rerank: z.coerce.boolean().optional(),
  topN: z.coerce.number().int().min(1).max(50).optional(),
});

export async function matchingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  // 7.1 — AdBrief intake.
  app.post(
    '/ad-briefs',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req, reply) => {
      const body = CreateAdBriefInputZ.parse(req.body);
      const created = await matchingService.createBrief(body, (req.user as { id: string }).id);
      await auditService.log({
        userId: (req.user as { id: string }).id,
        action: 'ad_brief.create',
        targetType: 'ad_brief',
        targetId: created.id,
        payload: { topic: created.topic },
      });
      reply.code(201);
      return created;
    },
  );

  app.get(
    '/ad-briefs/:id',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      return matchingService.getBrief(params.id);
    },
  );

  // 7.5 — match a persisted brief.
  app.post(
    '/ad-briefs/:id/match',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const opts = matchOptsZ.parse({
        ...(req.query as object),
        ...(req.body && typeof req.body === 'object' ? (req.body as object) : {}),
      });
      return matchingService.match(params.id, {
        ...(opts.rerank !== undefined && { rerank: opts.rerank }),
        ...(opts.topN !== undefined && { topN: opts.topN }),
      });
    },
  );

  // 7.5 — match an inline brief (persist + match in one call).
  app.post(
    '/match',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const brief = CreateAdBriefInputZ.parse(body.brief ?? body);
      const opts = matchOptsZ.parse({ ...(req.query as object), ...body });
      const created = await matchingService.createBrief(brief, (req.user as { id: string }).id);
      await auditService.log({
        userId: (req.user as { id: string }).id,
        action: 'ad_brief.create',
        targetType: 'ad_brief',
        targetId: created.id,
        payload: { topic: created.topic, inline: true },
      });
      return matchingService.match(created.id, {
        ...(opts.rerank !== undefined && { rerank: opts.rerank }),
        ...(opts.topN !== undefined && { topN: opts.topN }),
      });
    },
  );
}
