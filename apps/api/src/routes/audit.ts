import type { FastifyInstance } from 'fastify';
import { auditService } from '../services/audit.js';

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.get('/audit', async () => auditService.list());
}
