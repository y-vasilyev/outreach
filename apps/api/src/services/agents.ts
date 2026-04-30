import { getPrisma } from '@nosquare/db';
import { AgentRunner } from '@nosquare/agents';
import { endpointsService } from './endpoints.js';
import { Errors } from '@nosquare/shared';
import { logger } from '../logger.js';

let _runner: AgentRunner | undefined;

export function getAgentRunner(): AgentRunner {
  if (!_runner) {
    _runner = new AgentRunner({
      prisma: getPrisma(),
      endpointResolver: async (endpointId) => {
        if (!endpointId) {
          throw Errors.badRequest('agent has no endpoint configured');
        }
        return endpointsService.resolve(endpointId);
      },
      logger,
    });
  }
  return _runner;
}

export const agentsService = {
  async list() {
    const prisma = getPrisma();
    return prisma.agentConfig.findMany({
      orderBy: { name: 'asc' },
      include: { endpoint: true, fallbackEndpoint: true },
    });
  },

  async get(id: string) {
    const prisma = getPrisma();
    const a = await prisma.agentConfig.findUnique({
      where: { id },
      include: { endpoint: true, fallbackEndpoint: true },
    });
    if (!a) throw Errors.notFound('agent', id);
    return a;
  },

  async update(
    id: string,
    patch: {
      endpointId?: string | null;
      fallbackEndpointId?: string | null;
      model?: string;
      systemPrompt?: string;
      userPromptTemplate?: string;
      params?: Record<string, unknown>;
      enabled?: boolean;
    },
    actorId: string | null,
  ) {
    const prisma = getPrisma();
    const cur = await prisma.agentConfig.findUnique({ where: { id } });
    if (!cur) throw Errors.notFound('agent', id);

    const next = await prisma.$transaction(async (tx) => {
      await tx.agentConfigHistory.create({
        data: {
          agentConfigId: id,
          version: cur.version,
          snapshot: {
            model: cur.model,
            systemPrompt: cur.systemPrompt,
            userPromptTemplate: cur.userPromptTemplate,
            params: cur.params,
            endpointId: cur.endpointId,
            fallbackEndpointId: cur.fallbackEndpointId,
            enabled: cur.enabled,
          },
          changedById: actorId,
        },
      });
      return tx.agentConfig.update({
        where: { id },
        data: {
          endpointId: patch.endpointId === undefined ? cur.endpointId : patch.endpointId,
          fallbackEndpointId:
            patch.fallbackEndpointId === undefined ? cur.fallbackEndpointId : patch.fallbackEndpointId,
          model: patch.model ?? cur.model,
          systemPrompt: patch.systemPrompt ?? cur.systemPrompt,
          userPromptTemplate: patch.userPromptTemplate ?? cur.userPromptTemplate,
          params: (patch.params ?? cur.params) as object,
          enabled: patch.enabled ?? cur.enabled,
          version: cur.version + 1,
          updatedById: actorId,
        },
      });
    });

    return next;
  },

  async history(id: string, limit = 50) {
    const prisma = getPrisma();
    const a = await prisma.agentConfig.findUnique({ where: { id }, select: { name: true } });
    if (!a) throw Errors.notFound('agent', id);
    return prisma.agentRun.findMany({
      where: { agentName: a.name },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  async test(id: string, input: Record<string, unknown>) {
    const a = await this.get(id);
    const runner = getAgentRunner();
    const result = await runner.dryRun(a.name, input);
    return result;
  },
};
