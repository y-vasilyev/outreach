import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ExchangeRateCurrencyZ, ExchangeRateUpsertZ } from '@nosquare/shared';
import { exchangeRatesService } from '../services/exchange-rates.js';

/**
 * Settings → Exchange rates (price-normalization-v2). Admin-only, registered
 * unconditionally (like feature-flags): rates are operational reference data
 * the normalization pipeline depends on, not a feature surface. The web
 * Settings page shows an empty-state prompting USD/EUR until rates are set —
 * non-RUB offers stay visible but unnormalized meanwhile.
 */
export async function exchangeRatesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/settings/exchange-rates',
    { preHandler: [app.requireRole(['admin'])] },
    async () => exchangeRatesService.list(),
  );

  app.put(
    '/settings/exchange-rates/:currency',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const { currency } = z.object({ currency: ExchangeRateCurrencyZ }).parse(req.params);
      const body = ExchangeRateUpsertZ.parse(req.body);
      const userId = (req.user as { id: string }).id;
      return exchangeRatesService.upsert(currency, body, userId);
    },
  );

  app.delete(
    '/settings/exchange-rates/:currency',
    { preHandler: [app.requireRole(['admin'])] },
    async (req, reply) => {
      const { currency } = z.object({ currency: ExchangeRateCurrencyZ }).parse(req.params);
      await exchangeRatesService.remove(currency);
      return reply.code(204).send();
    },
  );
}
