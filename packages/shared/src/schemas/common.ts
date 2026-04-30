import { z } from 'zod';

export const PlatformZ = z.enum(['telegram', 'instagram', 'youtube']);
export const PaginationZ = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const SortDirZ = z.enum(['asc', 'desc']).default('desc');

export const IsoDateTimeZ = z.string().datetime();

export type Pagination = z.infer<typeof PaginationZ>;
