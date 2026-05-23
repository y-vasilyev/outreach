import type { FastifyInstance } from 'fastify';
import { dashboardService } from '../services/dashboard.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/metrics/dashboard', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async () => dashboardService.stats());
}
