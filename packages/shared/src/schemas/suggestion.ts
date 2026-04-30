import { z } from 'zod';

export const SuggestionStatusZ = z.enum([
  'pending',
  'approved',
  'edited',
  'rejected',
  'sent',
  'expired',
]);

export const SuggestionZ = z.object({
  id: z.string(),
  conversationId: z.string(),
  agentName: z.string(),
  text: z.string(),
  rationale: z.string(),
  score: z.number(),
  status: SuggestionStatusZ,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});

export type Suggestion = z.infer<typeof SuggestionZ>;
