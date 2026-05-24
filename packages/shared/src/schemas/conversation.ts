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

// Query parameters arrive as URL-encoded strings. An empty field on a form
// posts as `""`, not `undefined` — so without preprocessing, a request like
// `?status=&mode=` fails Zod enum validation. We normalise empties (and
// whitespace-only values) to `undefined` at the boundary so the service
// layer can rely on truthy checks. `q` additionally caps length to protect
// the downstream `ILIKE` scan. See inbox-campaign-filter design.md.
const trimEmptyToUndef = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
};

export const ConversationFiltersZ = z.object({
  status: z.preprocess(trimEmptyToUndef, ConversationStatusZ.optional()),
  mode: z.preprocess(trimEmptyToUndef, ConversationModeZ.optional()),
  campaignId: z.preprocess(trimEmptyToUndef, z.string().optional()),
  assignedOperatorId: z.preprocess(trimEmptyToUndef, z.string().optional()),
  q: z.preprocess(trimEmptyToUndef, z.string().max(200).optional()),
});

export const SetModeInputZ = z.object({
  conversationId: z.string(),
  mode: ConversationModeZ,
});

export type Conversation = z.infer<typeof ConversationZ>;
