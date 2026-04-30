import '@fastify/jwt';

interface AuthUserPayload {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUserPayload;
    user: AuthUserPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(req: import('fastify').FastifyRequest): Promise<void>;
    requireRole(roles: Array<'admin' | 'operator' | 'viewer'>): (
      req: import('fastify').FastifyRequest,
    ) => Promise<void>;
  }
}
