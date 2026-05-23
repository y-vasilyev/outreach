import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateCampaignInputZ } from '@nosquare/shared';
import { campaignsService } from '../services/campaigns.js';

export async function campaignsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/campaigns', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async () => campaignsService.list());

  app.get('/campaigns/:id', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.get(params.id);
  });

  app.post('/campaigns', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const body = CreateCampaignInputZ.parse(req.body);
    return campaignsService.create(body, (req.user as { id: string }).id);
  });

  app.patch('/campaigns/:id', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const patch = CreateCampaignInputZ.partial().parse(req.body);
    return campaignsService.update(params.id, patch);
  });

  app.post('/campaigns/:id/run', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.setStatus(params.id, 'running');
  });

  app.post('/campaigns/:id/pause', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return campaignsService.setStatus(params.id, 'paused');
  });

  app.post('/campaigns/:id/preview', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ limit: z.number().int().min(1).max(20).default(5) })
      .parse(req.body ?? {});
    return campaignsService.preview(params.id, body.limit);
  });

  app.post('/campaigns/:id/contacts', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ contactIds: z.array(z.string()).min(1).max(1000) })
      .parse(req.body);
    return campaignsService.addContacts(params.id, body.contactIds);
  });
}
