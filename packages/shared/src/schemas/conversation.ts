import { z } from 'zod';
import { QualityDecisionZ } from './ajtbd.js';

export const ConversationStatusZ = z.enum(['active', 'paused', 'done', 'failed', 'archived']);
export const ConversationModeZ = z.enum(['auto', 'semi_auto', 'assisted', 'manual']);

// Direction filter for the inbox.
//   - `i_messaged`    → "кому я написал": at least one outbound (lastOutboundAt set)
//   - `not_messaged`  → "кому я ещё не написал": no outbound yet (lastOutboundAt null)
//   - `they_replied`  → "кто мне ответил": the contact answered (lastInboundAt set)
export const ConversationActivityZ = z.enum(['i_messaged', 'not_messaged', 'they_replied']);

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

// `limit` arrives as a URL string ("200"). Coerce to a positive int and cap it
// so a client can't ask for an unbounded scan. The inbox uses a growing-window
// pager ("Load more" raises this), so there is no `offset`/`cursor`: the list
// is live (re-fetched every 5s, reordered by new inbound) and offset paging
// would shuffle rows between pages. Service default stays 100 when omitted.
const toPosIntOrUndef = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

export const ConversationFiltersZ = z.object({
  status: z.preprocess(trimEmptyToUndef, ConversationStatusZ.optional()),
  mode: z.preprocess(trimEmptyToUndef, ConversationModeZ.optional()),
  campaignId: z.preprocess(trimEmptyToUndef, z.string().optional()),
  assignedOperatorId: z.preprocess(trimEmptyToUndef, z.string().optional()),
  q: z.preprocess(trimEmptyToUndef, z.string().max(200).optional()),
  activity: z.preprocess(trimEmptyToUndef, ConversationActivityZ.optional()),
  limit: z.preprocess(toPosIntOrUndef, z.number().int().min(1).max(1000).optional()),
});

export const SetModeInputZ = z.object({
  conversationId: z.string(),
  mode: ConversationModeZ,
});

export type Conversation = z.infer<typeof ConversationZ>;
