import { z } from 'zod';

export const AgentParamsZ = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(32000).optional(),
    top_p: z.number().min(0).max(1).optional(),
    json_schema: z.unknown().optional(),
    min_confidence: z.number().min(0).max(1).optional(),
    enable_llm_classification: z.boolean().optional(),
    forbidden_topics: z.array(z.string()).optional(),
    escalation_keywords: z.array(z.string()).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    max_length: z.number().int().min(50).max(5000).optional(),
    allow_links: z.boolean().optional(),
    prefer_ad_manager_for_outreach: z.boolean().optional(),
  })
  .passthrough()
  .default({});

export const AgentConfigZ = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  endpointId: z.string().nullable(),
  fallbackEndpointId: z.string().nullable(),
  model: z.string(),
  systemPrompt: z.string(),
  userPromptTemplate: z.string(),
  params: AgentParamsZ,
  enabled: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string(),
});

export const UpdateAgentConfigInputZ = z.object({
  id: z.string(),
  endpointId: z.string().nullable().optional(),
  fallbackEndpointId: z.string().nullable().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  userPromptTemplate: z.string().optional(),
  params: AgentParamsZ.optional(),
  enabled: z.boolean().optional(),
});

export const TestAgentInputZ = z.object({
  id: z.string(),
  input: z.record(z.unknown()),
  dryRun: z.boolean().default(true),
});

export type AgentConfig = z.infer<typeof AgentConfigZ>;
export type AgentParams = z.infer<typeof AgentParamsZ>;
