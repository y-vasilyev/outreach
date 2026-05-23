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
  channelId: z.string().nullable(),
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
  /**
   * Filter by channel-attachment:
   *   true  → only cold leads (channelId IS NULL)
   *   false → only channel-bound contacts
   *   omitted → both
   */
  cold: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  /**
   * Page size. Default 1000 — operators routinely need to "select all"
   * across hundreds of contacts and feed them into a campaign; a low cap
   * silently breaks that workflow ("select all → only 200 ended up in the
   * batch"). Hard ceiling 5000 to keep the response payload sane.
   */
  limit: z
    .union([z.number(), z.string()])
    .transform((v) => {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(5000, Math.max(1, Math.floor(n)));
    })
    .optional(),
});

/**
 * Single manual-create input. Operator passes a value (type optional —
 * auto-detected by email/@handle/t.me/phone/URL). `channelId` is optional:
 * omit it for "cold leads" that don't belong to a tracked channel.
 * Manual entries always land with `extractedBy='manual'` so the
 * contact-extract worker won't clobber them.
 */
export const ContactCreateInputZ = z.object({
  channelId: z.string().min(1).nullable().optional(),
  type: ContactTypeZ.optional(),
  value: z.string().min(1).max(500),
  label: z.string().max(200).nullable().optional(),
  roleGuess: RoleGuessZ.optional(),
  status: ContactStatusZ.optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Bulk variant. Optional channelId + many lines. With `channelId` omitted
 * the whole batch is created as cold leads. Each item is either a
 * free-form string (auto-detected) or a structured object; `defaults`
 * applies role/status/etc to the whole batch.
 */
export const ContactBulkCreateInputZ = z.object({
  channelId: z.string().min(1).nullable().optional(),
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
