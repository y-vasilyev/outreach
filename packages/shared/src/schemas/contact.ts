import { z } from 'zod';

export const ContactTypeZ = z.enum([
  'tg_username',
  'tg_phone',
  'tg_link',
  'email',
  'website',
  'web_form',
  'other',
]);

export const RoleGuessZ = z.enum(['owner', 'ad_manager', 'generic', 'bot', 'unknown']);
export const ReachabilityZ = z.enum(['reachable_tg', 'manual', 'unreachable']);
export const ContactStatusZ = z.enum([
  'new',
  'qualified',
  'disqualified',
  'contacted',
  'active',
  'finished',
  'invalid',
  'blocked',
]);
export const ExtractedByZ = z.enum(['regex', 'llm', 'both', 'manual']);

export const ContactZ = z.object({
  id: z.string(),
  channelId: z.string(),
  type: ContactTypeZ,
  value: z.string(),
  rawValue: z.string(),
  label: z.string().nullable(),
  roleGuess: RoleGuessZ,
  confidence: z.number(),
  extractedBy: ExtractedByZ,
  reachability: ReachabilityZ,
  status: ContactStatusZ,
  tags: z.array(z.string()),
  tgUserId: z.string().nullable(),
  createdAt: z.string(),
});

export const ContactFiltersZ = z.object({
  channelId: z.string().optional(),
  type: ContactTypeZ.optional(),
  roleGuess: RoleGuessZ.optional(),
  reachability: ReachabilityZ.optional(),
  status: ContactStatusZ.optional(),
  q: z.string().optional(),
});

export type Contact = z.infer<typeof ContactZ>;
