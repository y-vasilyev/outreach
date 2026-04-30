import { z } from 'zod';

export const ProviderZ = z.enum(['yandex', 'openrouter', 'openai_compat']);

export const EndpointZ = z.object({
  id: z.string(),
  name: z.string(),
  provider: ProviderZ,
  baseUrl: z.string().url(),
  defaultHeaders: z.record(z.string()).default({}),
  rateLimitRpm: z.number().int().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateEndpointInputZ = z.object({
  name: z.string().min(1),
  provider: ProviderZ,
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  folderId: z.string().optional(),
  iamToken: z.string().optional(),
  defaultHeaders: z.record(z.string()).default({}),
  rateLimitRpm: z.number().int().min(1).max(100000).optional(),
  enabled: z.boolean().default(true),
});

export const UpdateEndpointInputZ = CreateEndpointInputZ.partial().extend({
  id: z.string(),
});

export type Endpoint = z.infer<typeof EndpointZ>;
