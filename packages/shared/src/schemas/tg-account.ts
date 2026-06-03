import { z } from 'zod';

export const TgAccountStatusZ = z.enum([
  'idle',
  'active',
  'cooldown',
  'banned',
  'need_auth',
]);
export const TgAccountRoleZ = z.enum(['parser', 'outreach', 'both']);

export const TgAccountZ = z.object({
  id: z.string(),
  label: z.string(),
  phone: z.string(),
  status: TgAccountStatusZ,
  role: TgAccountRoleZ,
  dailyMsgLimit: z.number().int(),
  dailyNewContactLimit: z.number().int(),
  parserRpm: z.number().int().nullable(),
  outreachRpm: z.number().int().nullable(),
  sentTodayMsg: z.number().int(),
  sentTodayNew: z.number().int(),
  cooldownUntil: z.string().nullable(),
  warmupStage: z.number().int(),
  warmupStartedAt: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
});

export const CreateTgAccountInputZ = z.object({
  label: z.string().min(1),
  phone: z.string().min(5),
  role: TgAccountRoleZ,
  dailyMsgLimit: z.number().int().min(1).max(200).default(30),
  dailyNewContactLimit: z.number().int().min(1).max(100).default(15),
  // Per-account RPM caps. null/undefined → fall back to env default
  // (TG_PARSER_RPM / TG_OUTREACH_RPM) or unlimited when env is unset.
  parserRpm: z.number().int().min(1).max(1000).nullable().optional(),
  outreachRpm: z.number().int().min(1).max(1000).nullable().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const StartLoginInputZ = z.object({
  tgAccountId: z.string(),
});

export const ConfirmCodeInputZ = z.object({
  tgAccountId: z.string(),
  code: z.string().min(4),
});

export const ConfirmPasswordInputZ = z.object({
  tgAccountId: z.string(),
  password: z.string().min(1),
});

export type TgAccount = z.infer<typeof TgAccountZ>;
