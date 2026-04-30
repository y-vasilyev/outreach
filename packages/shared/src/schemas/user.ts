import { z } from 'zod';

export const UserRoleZ = z.enum(['admin', 'operator', 'viewer']);

export const UserZ = z.object({
  id: z.string(),
  email: z.string().email(),
  role: UserRoleZ,
  settings: z.record(z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const LoginInputZ = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const CreateUserInputZ = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: UserRoleZ.default('operator'),
});

export type User = z.infer<typeof UserZ>;
