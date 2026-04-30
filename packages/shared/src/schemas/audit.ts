import { z } from 'zod';

export const AuditLogZ = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});

export type AuditLog = z.infer<typeof AuditLogZ>;
