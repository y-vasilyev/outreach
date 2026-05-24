import { z } from 'zod';
import { PlatformZ } from './common.js';
import { RoleGuessZ } from './contact.js';

export const CampaignModeZ = z.enum(['auto', 'semi_auto', 'assisted', 'manual']);
export const CampaignStatusZ = z.enum(['draft', 'running', 'paused', 'finished']);

export const TargetFilterZ = z
  .object({
    platforms: z.array(PlatformZ).optional(),
    roleGuess: z.array(RoleGuessZ).optional(),
    languages: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .default({});

export const ScheduleZ = z
  .object({
    tz: z.string().default('Europe/Moscow'),
    workHours: z
      .object({ start: z.string(), end: z.string() })
      .default({ start: '10:00', end: '20:00' }),
    days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
    maxPerDayPerAccount: z.number().int().min(1).max(200).default(20),
  })
  .default({});

export const CampaignZ = z.object({
  id: z.string(),
  name: z.string(),
  goalText: z.string(),
  valueProp: z.string(),
  // Campaign-type registry (agency-sourcing-matching change). Nullable
  // during the backfill window; `goal` is validated against the type's
  // goalSchema server-side. Note: the legacy `Campaign.ajtbd` storage
  // column was removed by `drop-campaign-ajtbd-column` — the AJTBD view
  // for CustDev now lives inside `goal`.
  typeId: z.string().nullable(),
  goal: z.record(z.unknown()).nullable(),
  targetFilter: TargetFilterZ,
  agentOverrides: z.record(z.unknown()).default({}),
  outreachAccountPool: z.array(z.string()),
  schedule: ScheduleZ,
  defaultMode: CampaignModeZ,
  status: CampaignStatusZ,
  createdAt: z.string(),
});

export const CreateCampaignInputZ = z.object({
  name: z.string().min(1),
  goalText: z.string().min(1),
  valueProp: z.string().min(1),
  // Campaign type to attach. Defaults to `custdev` server-side when omitted
  // (preserves pre-registry behavior). `goal` is validated against the
  // type's goalSchema; for custdev the server scaffolds an AJTBD shape
  // from `goalText` + `valueProp` if `goal` is omitted.
  typeId: z.string().optional(),
  goal: z.record(z.unknown()).optional(),
  targetFilter: TargetFilterZ,
  agentOverrides: z.record(z.unknown()).default({}),
  outreachAccountPool: z.array(z.string()).default([]),
  schedule: ScheduleZ,
  defaultMode: CampaignModeZ.default('assisted'),
});

export const UpdateCampaignInputZ = CreateCampaignInputZ.partial().extend({
  id: z.string(),
});

export type Campaign = z.infer<typeof CampaignZ>;
