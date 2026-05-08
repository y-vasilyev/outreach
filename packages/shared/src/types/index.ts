export type Platform = 'telegram' | 'instagram' | 'youtube';
export type UserRole = 'admin' | 'operator' | 'viewer';
export type ContactType =
  | 'tg_username'
  | 'tg_phone'
  | 'tg_link'
  | 'email'
  | 'website'
  | 'web_form'
  | 'other';
export type RoleGuess = 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown';
export type Reachability = 'reachable_tg' | 'manual' | 'unreachable';
export type ContactStatus =
  | 'new'
  | 'qualified'
  | 'disqualified'
  | 'contacted'
  | 'active'
  | 'finished'
  | 'invalid'
  | 'blocked';
export type ChannelStatus =
  | 'new'
  | 'scraping'
  | 'scraped'
  | 'extracting'
  | 'extracted'
  | 'ready'
  | 'done'
  | 'failed';

export type ConversationMode = 'auto' | 'semi_auto' | 'assisted' | 'manual';
export type ConversationStatus = 'active' | 'paused' | 'done' | 'failed';
export type MessageDirection = 'in' | 'out';
export type MessageSender = 'contact' | 'ai' | 'operator' | 'system';
export type MessageStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'received';
export type SuggestionStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'rejected'
  | 'sent'
  | 'expired';

export type TgAccountStatus =
  | 'idle'
  | 'active'
  | 'cooldown'
  | 'banned'
  | 'need_auth';
export type TgAccountRole = 'parser' | 'outreach' | 'both';

export type LLMProviderKind = 'yandex' | 'openrouter' | 'openai_compat';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'finished';
export type Intent =
  | 'interested'
  | 'needs_more_info'
  | 'asks_about_product'
  | 'objection_busy'
  | 'objection_irrelevant'
  | 'objection_compensation'
  | 'wants_payment_for_ads'
  | 'wants_to_schedule'
  | 'declined'
  | 'hostile'
  | 'spam_complaint'
  | 'request_human'
  | 'silence_likely';
