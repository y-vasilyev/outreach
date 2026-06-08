import type {
  ConversationMode,
  ConversationStatus,
  MessageDirection,
  MessageSender,
  SuggestionStatus,
} from './types/index.js';

export type RealtimeRoom =
  | `conversation:${string}`
  | `channel:${string}`
  | `campaign:${string}`
  | `operator:${string}`
  | 'admin:dashboard';

export interface MessageAttachment {
  kind: 'image' | 'video' | 'document' | 'other';
  mime?: string;
  fileName?: string;
  bytes?: number;
  /**
   * MediaAsset.id resolved on the read side once the byte upload landed in S3.
   * UI fetches a short-lived presigned GET URL via `/media-assets/:id/download-url`.
   * Absent for media that wasn't uploaded (flag off or honest-pending row).
   */
  assetId?: string;
}

export interface MessageEvent {
  type: 'message.new';
  conversationId: string;
  message: {
    id: string;
    direction: MessageDirection;
    sender: MessageSender;
    text: string;
    attachments?: MessageAttachment[];
    createdAt: string;
  };
}

/**
 * Per-message extraction status changed (operator-reanalyze-and-markup). Lets
 * the inbox show pending→result for a re-run without polling.
 */
export interface MessageExtractionStatusEvent {
  type: 'message.extraction_status.changed';
  conversationId: string;
  messageId: string;
  extractionStatus: 'pending' | 'ok' | 'empty' | 'no_signal' | 'failed';
  extractionError?: string | null;
}

export interface SuggestionEvent {
  type: 'suggestion.new';
  conversationId: string;
  suggestion: {
    id: string;
    agentName: string;
    text: string;
    rationale: string;
    score: number;
    status: SuggestionStatus;
    createdAt: string;
  };
}

export interface StatusChangedEvent {
  type: 'status.changed';
  conversationId: string;
  status: ConversationStatus;
}

export interface ModeChangedEvent {
  type: 'mode.changed';
  conversationId: string;
  mode: ConversationMode;
}

/**
 * Emitted when an operator hard-deletes an off-target conversation. The inbox
 * uses it to drop the row (and navigate away if it was the open thread)
 * without waiting for the next refetch. Broadcast on both the conversation
 * room and (when bound) the campaign room.
 */
export interface ConversationDeletedEvent {
  type: 'conversation.deleted';
  conversationId: string;
}

export interface ChannelProgressEvent {
  type: 'channel.progress';
  channelId: string;
  status: string;
  detail?: string;
}

export interface CampaignTickEvent {
  type: 'campaign.tick';
  campaignId: string;
  contactsQueued: number;
  contactsSent: number;
}

export interface DashboardEvent {
  type: 'dashboard.update';
  payload: Record<string, unknown>;
}

export interface OperatorAssignmentEvent {
  type: 'operator.assigned';
  conversationId: string;
  reason: string;
  urgency: 'low' | 'normal' | 'high';
}

/**
 * Emitted when an agent in a conversation pipeline fails and the runtime
 * degrades the conversation into `assisted` mode (per CLAUDE.md "Не ронять
 * оператору диалог"). The UI uses this to show a banner with the agent
 * name and reason so the operator knows why suggestions are missing.
 */
export interface AgentFailedEvent {
  type: 'agent.failed';
  conversationId: string;
  agentName: string;
  /** Error code from AppError when known (LLM_SCHEMA_FAILED, LLM_TRANSIENT, …). */
  code?: string;
  /** Short, operator-readable reason. */
  reason: string;
}

/**
 * Emitted when a suggestion is approved (manually by the operator OR
 * automatically by `tryAutoApprove` in auto-mode conversations). The UI
 * uses it to flip the suggestion's row from `pending` to `approved`
 * without waiting for the next refetch.
 */
export interface SuggestionApprovedEvent {
  type: 'suggestion.approved';
  conversationId: string;
  suggestionId: string;
  /** True when the runtime approved without an operator click. */
  auto?: boolean;
}

/**
 * Emitted by the on_inbound pipeline whenever the GoalFitEvaluator gate
 * produces a decision in `semi_auto` / `auto` conversations. Operator
 * UI uses it to surface the latest goal-fit verdict (banner +
 * "AI handed off" indicator) without polling.
 *
 * **Routing**: this event is published only to the operator-side
 * realtime channel(s) for the conversation. It must NOT reach any
 * contact-facing surface — the silent-fallback contract requires the
 * contact to perceive nothing when the AI hands off.
 */
export interface QualityGateEvent {
  type: 'quality.gate';
  conversationId: string;
  score: number;
  action: 'continue' | 'soften' | 'handoff_silent';
  reasons: string[];
  decidedAt: string;
}

/**
 * Emitted by workers (`profile-extract`, `agent-run`) after a
 * `ProfileDataPoint` write or a `Suggestion` create whose
 * `meta.targetField` is set. The web inbox right panel patches its
 * local data-collection HUD state without re-fetching. Routing is the
 * conversation's existing realtime room. Delivery is gated by the
 * `data_collection_hud` runtime flag — emitters early-return when off,
 * so consumers MUST tolerate gaps.
 */
export interface DataCollectionUpdatedEvent {
  type: 'data_collection.updated';
  conversationId: string;
  targetKey: string;
  state: 'answered' | 'asked' | 'missing' | 'stale';
  current?: {
    value: unknown;
    capturedAt: string;
    sourceMessageId?: string;
    sourceField: string;
  };
  freshness?: {
    stale: boolean;
    ageDays: number | null;
  };
  lastAskedAt?: string;
}

export type RealtimeEvent =
  | MessageEvent
  | MessageExtractionStatusEvent
  | SuggestionEvent
  | SuggestionApprovedEvent
  | StatusChangedEvent
  | ModeChangedEvent
  | ConversationDeletedEvent
  | ChannelProgressEvent
  | CampaignTickEvent
  | DashboardEvent
  | OperatorAssignmentEvent
  | AgentFailedEvent
  | QualityGateEvent
  | DataCollectionUpdatedEvent;
