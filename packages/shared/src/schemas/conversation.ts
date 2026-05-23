import { z } from 'zod';
import { QualityDecisionZ } from './ajtbd.js';

export const ConversationStatusZ = z.enum(['active', 'paused', 'done', 'failed']);
export const ConversationModeZ = z.enum(['auto', 'semi_auto', 'assisted', 'manual']);

export const ConversationZ = z.object({
  id: z.string(),
  tgAccountId: z.string(),
  contactId: z.string(),
  campaignId: z.string().nullable(),
  status: ConversationStatusZ,
  mode: ConversationModeZ,
  assignedOperatorId: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
  lastOutboundAt: z.string().nullable(),
  qualityDecision: QualityDecisionZ.nullable(),
  lastSyncedAt: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string(),
});

export const ConversationFiltersZ = z.object({
  status: ConversationStatusZ.optional(),
  mode: ConversationModeZ.optional(),
  campaignId: z.string().optional(),
  assignedOperatorId: z.string().optional(),
  q: z.string().optional(),
});

export const SetModeInputZ = z.object({
  conversationId: z.string(),
  mode: ConversationModeZ,
});

export type Conversation = z.infer<typeof ConversationZ>;
