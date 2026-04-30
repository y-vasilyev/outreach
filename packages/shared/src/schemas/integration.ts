import { z } from 'zod';

export const IntegrationKindZ = z.enum(['scrapecreators']);

export const IntegrationZ = z.object({
  id: z.string(),
  kind: IntegrationKindZ,
  enabled: z.boolean(),
  status: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
});

export const UpsertIntegrationInputZ = z.object({
  kind: IntegrationKindZ,
  apiKey: z.string().min(8),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
});

export type Integration = z.infer<typeof IntegrationZ>;
