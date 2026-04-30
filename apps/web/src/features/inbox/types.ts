export interface ConversationContact {
  id: string;
  value: string;
  roleGuess?: string;
  channel?: { id?: string; handle?: string; title?: string; platform?: string; topic?: string; followers?: number };
}

export interface ConversationListItem {
  id: string;
  contact?: ConversationContact;
  status: 'active' | 'paused' | 'done' | 'failed';
  mode: 'auto' | 'assisted' | 'manual';
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
