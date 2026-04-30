export type ContactType =
  | 'tg_username'
  | 'tg_phone'
  | 'tg_link'
  | 'email'
  | 'website'
  | 'web_form'
  | 'other';

export type ContactRole = 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown';

export type ContactReach = 'reachable_tg' | 'manual' | 'unreachable';

export type ContactStatus =
  | 'new'
  | 'qualified'
  | 'disqualified'
  | 'contacted'
  | 'active'
  | 'finished'
  | 'invalid'
  | 'blocked';

/** `manual` is set whenever an operator hand-edits the contact via PATCH. */
export type ExtractedBy = 'regex' | 'llm' | 'both' | 'manual';

export interface Contact {
  id: string;
  channelId: string;
  channel?: { id: string; title?: string; handle?: string; platform?: string };
  type: ContactType;
  value: string;
  rawValue?: string;
  label?: string | null;
  roleGuess: ContactRole;
  confidence: number;
  reachability: ContactReach;
  status: ContactStatus;
  extractedBy?: ExtractedBy;
  tags?: string[];
  tgUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}
