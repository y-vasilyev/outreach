export interface ChannelAnalysis {
  language?: 'ru' | 'en' | 'other';
  topic?: string;
  audience?: string;
  format?: string;
  tone?: 'formal' | 'casual' | 'edgy' | 'neutral';
  owner_signals?: { is_personal_brand?: boolean; owner_hint?: string };
  red_flags?: string[];
  [key: string]: unknown;
}

export interface ConversationChannel {
  id?: string;
  handle?: string;
  title?: string;
  platform?: 'telegram' | 'instagram' | 'youtube' | string;
  description?: string | null;
  links?: string[];
  followers?: number;
  language?: string | null;
  analysis?: ChannelAnalysis | null;
}

export interface ConversationContact {
  id: string;
  value: string;
  roleGuess?: string;
  label?: string | null;
  tgUsername?: string | null;
  tgFirstName?: string | null;
  tgLastName?: string | null;
  channel?: ConversationChannel;
}

export type ConversationMode = 'auto' | 'semi_auto' | 'assisted' | 'manual';

export interface QualityDecision {
  score: number;
  action: 'continue' | 'soften' | 'handoff_silent';
  reasons: string[];
  decidedAt: string;
}

export interface ConversationListItem {
  id: string;
  contact?: ConversationContact;
  status: 'active' | 'paused' | 'done' | 'failed';
  mode: ConversationMode;
  lastMessageText?: string;
  lastMessageAt?: string;
  lastInboundAt?: string | null;
  unread?: number;
  pendingSuggestions?: number;
  campaign?: { id: string; name: string };
}

export interface ConversationDetail extends ConversationListItem {
  summary?: string | null;
  meta?: Record<string, unknown>;
  tgAccount?: { label: string; phone: string };
  qualityDecision?: QualityDecision | null;
  lastSyncedAt?: string | null;
}

export interface ChatMessage {
  id: string;
  /** Prisma enum keys (`in_` / `out_` because `in`/`out` are reserved). */
  direction: 'in_' | 'out_';
  sender: 'contact' | 'ai' | 'operator' | 'system';
  text: string;
  status?: 'pending' | 'sending' | 'sent' | 'failed' | 'received';
  createdAt: string;
  sentAt?: string | null;
  agentName?: string;
}

export interface Suggestion {
  id: string;
  conversationId: string;
  agentName: string;
  text: string;
  rationale?: string;
  score?: number;
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'sent' | 'expired';
  /** Backend stores meta keys in snake_case. */
  meta?: { intent_target?: string; risk_score?: number; length?: string; confidence?: number; label?: string; tone?: string };
  createdAt: string;
}
