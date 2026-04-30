import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './env.js';
import { logger } from './logger.js';
import { registerAuth } from './auth/plugin.js';
import { registerErrorHandler } from './error-handler.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { tgAccountsRoutes } from './routes/tg-accounts.js';
import { integrationsRoutes } from './routes/integrations.js';
import { endpointsRoutes } from './routes/endpoints.js';
import { agentsRoutes } from './routes/agents.js';
import { channelsRoutes } from './routes/channels.js';
import { contactsRoutes } from './routes/contacts.js';
import { campaignsRoutes } from './routes/campaigns.js';
import { conversationsRoutes } from './routes/conversations.js';
import { usersRoutes } from './routes/users.js';
import { auditRoutes } from './routes/audit.js';
import { metricsRoutes } from './routes/metrics.js';
import { attachIo } from './realtime/io.js';

async function main() {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: [env.WEB_ORIGIN, 'http://localhost:5173'],
    credentials: true,
  });
  await app.register(sensible);
  await registerAuth(app);
  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(tgAccountsRoutes);
  await app.register(integrationsRoutes);
  await app.register(endpointsRoutes);
  await app.register(agentsRoutes);
  await app.register(channelsRoutes);
  await app.register(contactsRoutes);
  await app.register(campaignsRoutes);
  await app.register(conversationsRoutes);
  await app.register(usersRoutes);
  await app.register(auditRoutes);
  await app.register(metricsRoutes);

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  attachIo(app.server);
  logger.info(
    `API listening on http://${env.API_HOST}:${env.API_PORT} (web origin: ${env.WEB_ORIGIN})`,
  );
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
