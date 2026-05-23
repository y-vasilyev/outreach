import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentConfig as DbAgentConfig, PrismaClient } from '@nosquare/db';

import { AgentRunner, type ResolvedEndpoint } from '../AgentRunner.js';
import { agentRegistry } from '../registry.js';
import type { Agent } from '../types.js';

/**
 * AgentRunner implementation resolution (agency-sourcing-matching FIX B1).
 *
 * The campaign-type builder saves per-type agent_config rows under a unique
 * name (e.g. `podcast_guesting_opening_composer`) whose `role` is the canonical
 * registered implementation (e.g. `opening_composer`). AgentRunner must resolve
 * the implementation by name when registered, else fall back to `config.role`,
 * and 404 when neither resolves.
 */

// A trivial registered implementation that does NOT touch the LLM, so no real
// provider calls happen during the test.
const fakeImpl: Agent<{ x: string }, { y: string }> = {
  name: 'fake_impl',
  description: 'test impl',
  inputSchema: z.object({ x: z.string() }),
  outputSchema: z.object({ y: z.string() }),
  variables: [],
  async run(input) {
    return { y: `ok:${input.x}` };
  },
};

function makeConfigRow(over: Partial<DbAgentConfig>): DbAgentConfig {
  return {
    id: 'cfg_x',
    name: 'unused',
    role: '',
    description: '',
    endpointId: 'ep_test',
    fallbackEndpointId: null,
    model: 'test-model',
    systemPrompt: 'sys',
    userPromptTemplate: 'user',
    params: {},
    enabled: true,
    version: 1,
    updatedById: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...over,
  } as unknown as DbAgentConfig;
}

const resolver = async (): Promise<ResolvedEndpoint> => ({
  provider: 'openrouter',
  baseUrl: 'https://example.test',
  apiKey: 'sk-test',
});

describe('AgentRunner implementation resolution', () => {
  beforeEach(() => {
    agentRegistry.register(fakeImpl);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a saved-style config whose name is unknown but role is a registered impl', async () => {
    const row = makeConfigRow({
      name: 'podcast_guesting_fake_impl',
      role: 'fake_impl', // canonical registered implementation key
    });
    const prisma = {
      agentConfig: { findUnique: vi.fn().mockResolvedValue(row) },
      agentRun: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const runner = new AgentRunner({ prisma, endpointResolver: resolver });
    const out = await runner.run<{ y: string }>('podcast_guesting_fake_impl', { x: 'hi' });

    expect(out.y).toBe('ok:hi');
    // Persisted under the resolved implementation's name.
    const createMock = (prisma.agentRun.create as unknown as ReturnType<typeof vi.fn>);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0].data.agentName).toBe('fake_impl');
  });

  it('uses the name directly when it IS a registered implementation', async () => {
    const row = makeConfigRow({ name: 'fake_impl', role: 'something_else' });
    const prisma = {
      agentConfig: { findUnique: vi.fn().mockResolvedValue(row) },
      agentRun: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const runner = new AgentRunner({ prisma, endpointResolver: resolver });
    const out = await runner.run<{ y: string }>('fake_impl', { x: 'a' });
    expect(out.y).toBe('ok:a');
  });

  it('throws notFound when neither the name nor the role is a registered impl', async () => {
    const row = makeConfigRow({ name: 'mystery', role: 'also_unknown' });
    const prisma = {
      agentConfig: { findUnique: vi.fn().mockResolvedValue(row) },
      agentRun: { create: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    const runner = new AgentRunner({ prisma, endpointResolver: resolver });
    await expect(runner.run('mystery', { x: 'a' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
