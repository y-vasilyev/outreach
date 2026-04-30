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

/**
 * Single manual-create input. Operator passes the channel + at least a value;
 * type can be omitted and the server will auto-detect (email regex, @handle,
 * t.me/ link, etc.). All operator-created contacts land with
 * `extractedBy='manual'` so the contact-extract worker won't clobber them.
 */
export const ContactCreateInputZ = z.object({
  channelId: z.string().min(1),
  type: ContactTypeZ.optional(),
  value: z.string().min(1).max(500),
  label: z.string().max(200).nullable().optional(),
  roleGuess: RoleGuessZ.optional(),
  status: ContactStatusZ.optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Bulk variant. One channelId + many lines. Each line is either a free-form
 * string (auto-detected) or a structured object. Defaults can be applied to
 * the whole batch via `defaults` (e.g. role=ad_manager, status=qualified).
 */
export const ContactBulkCreateInputZ = z.object({
  channelId: z.string().min(1),
  items: z
    .array(
      z.union([
        z.string().min(1).max(500),
        z.object({
          type: ContactTypeZ.optional(),
          value: z.string().min(1).max(500),
          label: z.string().max(200).nullable().optional(),
          roleGuess: RoleGuessZ.optional(),
          status: ContactStatusZ.optional(),
          confidence: z.number().min(0).max(1).optional(),
        }),
      ]),
    )
    .min(1)
    .max(2000),
  defaults: z
    .object({
      type: ContactTypeZ.optional(),
      roleGuess: RoleGuessZ.optional(),
      status: ContactStatusZ.optional(),
      confidence: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

export type Contact = z.infer<typeof ContactZ>;
export type ContactCreateInput = z.infer<typeof ContactCreateInputZ>;
export type ContactBulkCreateInput = z.infer<typeof ContactBulkCreateInputZ>;
