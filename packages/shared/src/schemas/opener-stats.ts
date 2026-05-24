import { z } from 'zod';

/**
 * Query schema for `GET /campaigns/:id/opener-stats?withinHours=<H>`.
 *
 * `withinHours` defines the time window in which an inbound message
 * after an outbound opener counts as a "reply" for the per-variant
 * reply-rate aggregate. Defaults to 48 hours; capped at 720 (30 days)
 * to keep the SQL bounded and to discourage misreading early outreach
 * conversion as long-funnel attribution.
 *
 * See ab-opener-variants change, design.md decisions 2 + 5.
 */
export const OpenerStatsQueryZ = z.object({
  withinHours: z.coerce.number().int().min(1).max(720).default(48),
});

export type OpenerStatsQuery = z.infer<typeof OpenerStatsQueryZ>;

/**
 * One row per distinct `Message.openerVariant` observed across the
 * campaign's outbound traffic.
 *
 * - `sent`: count of `Message` rows for this variant in `status = 'sent'`.
 * - `replied`: count of `sent` rows for which the same conversation has
 *   at least one inbound `Message` within `withinHours` of the opener's
 *   `sentAt`.
 * - `replyRate`: `replied / sent`, clamped to `[0, 1]` defensively.
 */
export const OpenerStatsRowZ = z.object({
  variantKey: z.string().min(1),
  sent: z.number().int().min(0),
  replied: z.number().int().min(0),
  replyRate: z.number().min(0).max(1),
});

export type OpenerStatsRow = z.infer<typeof OpenerStatsRowZ>;

export const OpenerStatsZ = z.array(OpenerStatsRowZ);

export type OpenerStats = z.infer<typeof OpenerStatsZ>;
