export interface Contact {
  id: string;
  channelId: string;
  channel?: { id: string; title?: string; handle?: string; platform?: string };
  type: 'tg_username' | 'tg_phone' | 'tg_link' | 'email' | 'website' | 'web_form' | 'other';
  value: string;
  rawValue?: string;
  label?: string | null;
  roleGuess: 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown';
  confidence: number;
  reachability: 'reachable_tg' | 'manual' | 'unreachable';
  status: 'new' | 'qualified' | 'disqualified' | 'contacted' | 'active' | 'finished' | 'invalid' | 'blocked';
  tags?: string[];
  tgUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}
