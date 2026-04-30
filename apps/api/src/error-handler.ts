import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { isAppError } from '@nosquare/shared';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: err.flatten() },
      });
      return;
    }
    if (isAppError(err)) {
      reply.status(err.statusCode).send(err.toJSON());
      return;
    }
    req.log.error({ err }, 'Unhandled error');
    reply.status(err.statusCode ?? 500).send({
      error: { code: 'INTERNAL', message: err.message ?? 'Internal error' },
    });
  });
}
