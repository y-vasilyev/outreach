import type { FastifyInstance, FastifyRequest } from 'fastify';
import jwtPlugin from '@fastify/jwt';
import { Errors } from '@nosquare/shared';
import { env } from '../env.js';

export async function registerAuth(app: FastifyInstance) {
  await app.register(jwtPlugin, { secret: env.JWT_SECRET });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw Errors.unauthorized();
    }
  });

  app.decorate(
    'requireRole',
    (roles: Array<'admin' | 'operator' | 'viewer'>) =>
      async (req: FastifyRequest) => {
        if (!req.user) throw Errors.unauthorized();
        if (!roles.includes(req.user.role)) throw Errors.forbidden('Role not permitted');
      },
  );
}
