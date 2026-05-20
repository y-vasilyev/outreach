import { getPrisma } from '@nosquare/db';
import {
  Errors,
  CampaignAjtbdZ,
  BUILTIN_CAMPAIGN_TYPE_KEYS,
  type CreateCampaignTypeInput,
  type UpdateCampaignTypeInput,
} from '@nosquare/shared';

/**
 * Campaign-type registry service (agency-sourcing-matching change).
 *
 * Loads/edits the configurable campaign types and validates a campaign's
 * structured `goal` against the active type's `goalSchema`. The validator
 * is intentionally lightweight (no full JSON-schema engine): the `custdev`
 * type reuses the existing AJTBD zod schema; every other type enforces the
 * `required` key list declared on its `goalSchema`. That covers the spec's
 * "missing required field → 400" contract without a new dependency.
 */
export const campaignTypesService = {
  async list() {
    const prisma = getPrisma();
    return prisma.campaignType.findMany({ orderBy: { createdAt: 'asc' } });
  },

  async get(id: string) {
    const prisma = getPrisma();
    const t = await prisma.campaignType.findUnique({ where: { id } });
    if (!t) throw Errors.notFound('campaign_type', id);
    return t;
  },

  async getByKey(key: string) {
    const prisma = getPrisma();
    return prisma.campaignType.findUnique({ where: { key } });
  },

  async create(input: CreateCampaignTypeInput) {
    const prisma = getPrisma();
    if ((BUILTIN_CAMPAIGN_TYPE_KEYS as readonly string[]).includes(input.key)) {
      throw Errors.badRequest(`campaign type key "${input.key}" is reserved`, {
        key: input.key,
      });
    }
    const existing = await prisma.campaignType.findUnique({ where: { key: input.key } });
    if (existing) {
      throw Errors.conflict(`campaign type "${input.key}" already exists`);
    }
    return prisma.campaignType.create({
      data: {
        key: input.key,
        name: input.name,
        description: input.description,
        goalSchema: input.goalSchema as object,
        agentSet: input.agentSet as object,
        safetyProfile: input.safetyProfile as object,
        autonomyPolicy: input.autonomyPolicy as object,
        builtIn: false,
        enabled: input.enabled,
      },
    });
  },

  async update(id: string, patch: Partial<UpdateCampaignTypeInput>) {
    const prisma = getPrisma();
    const existing = await prisma.campaignType.findUnique({ where: { id } });
    if (!existing) throw Errors.notFound('campaign_type', id);
    // `key` is immutable once created (campaigns reference the row by id, but
    // the key is a stable contract used by pipelines/seed).
    return prisma.campaignType.update({
      where: { id },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.goalSchema !== undefined && { goalSchema: patch.goalSchema as object }),
        ...(patch.agentSet !== undefined && { agentSet: patch.agentSet as object }),
        ...(patch.safetyProfile !== undefined && { safetyProfile: patch.safetyProfile as object }),
        ...(patch.autonomyPolicy !== undefined && { autonomyPolicy: patch.autonomyPolicy as object }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      },
    });
  },

  /**
   * Validate a campaign goal against a campaign type. Returns the normalized
   * goal to persist. Throws `badRequest` (→ 400) referencing the failing
   * path when validation fails.
   */
  validateGoal(type: { key: string; goalSchema: unknown }, goal: unknown): object {
    if (type.key === 'custdev') {
      const parsed = CampaignAjtbdZ.safeParse(goal);
      if (!parsed.success) {
        throw Errors.badRequest('invalid custdev goal (ajtbd)', {
          path: parsed.error.issues[0]?.path.join('.') ?? '',
          error: parsed.error.message,
        });
      }
      return parsed.data;
    }

    if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) {
      throw Errors.badRequest('goal must be an object', { typeKey: type.key });
    }
    const schema = (type.goalSchema ?? {}) as { required?: unknown };
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    const goalObj = goal as Record<string, unknown>;
    for (const key of required) {
      if (typeof key === 'string' && !(key in goalObj)) {
        throw Errors.badRequest(`goal is missing required field "${key}"`, {
          typeKey: type.key,
          path: key,
        });
      }
    }
    return goalObj;
  },
};
