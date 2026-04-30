import { z } from 'zod';
import { PlatformZ } from './common.js';

export const ChannelStatusZ = z.enum([
  'new',
  'scraping',
  'scraped',
  'extracting',
  'extracted',
  'ready',
  'done',
  'failed',
]);

export const ChannelAnalysisZ = z
  .object({
    language: z.enum(['ru', 'en', 'other']).optional(),
    topic: z.string().optional(),
    audience: z.string().optional(),
    format: z.string().optional(),
    tone: z.enum(['formal', 'casual', 'edgy', 'neutral']).optional(),
    owner_signals: z
      .object({
        is_personal_brand: z.boolean(),
        owner_hint: z.string().optional(),
      })
      .optional(),
    red_flags: z.array(z.string()).default([]),
  })
  .partial()
  .passthrough();

export const ChannelZ = z.object({
  id: z.string(),
  platform: PlatformZ,
  externalId: z.string().nullable(),
  handle: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  links: z.array(z.string()),
  followers: z.number().int().nullable(),
  language: z.string().nullable(),
  analysis: ChannelAnalysisZ.nullable(),
  status: ChannelStatusZ,
  source: z.string(),
  scrapedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * Two accepted shapes:
 *   - { platform, handles[] } — explicit single-platform import
 *   - { items[], platform_hint? } — mixed list, server detects platform per line
 */
export const ImportChannelsInputZ = z
  .object({
    platform: PlatformZ.optional(),
    handles: z.array(z.string().min(2)).max(2000).optional(),
    items: z.array(z.string().min(2)).max(2000).optional(),
    platform_hint: PlatformZ.optional(),
    source: z.string().default('manual'),
  })
  .refine(
    (v) =>
      (Array.isArray(v.handles) && v.handles.length > 0) ||
      (Array.isArray(v.items) && v.items.length > 0),
    { message: 'Provide either handles[] or items[]', path: ['items'] },
  );

export const ChannelFiltersZ = z.object({
  platform: PlatformZ.optional(),
  status: ChannelStatusZ.optional(),
  q: z.string().optional(),
});

export type Channel = z.infer<typeof ChannelZ>;
export type ChannelAnalysis = z.infer<typeof ChannelAnalysisZ>;
