export interface TgAccount {
  id: string;
  label: string;
  phone: string;
  status: 'idle' | 'active' | 'cooldown' | 'banned' | 'need_auth';
  role: 'parser' | 'outreach' | 'both';
  dailyMsgLimit: number;
  dailyNewContactLimit: number;
  /** Per-account RPM caps (null = use TG_PARSER_RPM / TG_OUTREACH_RPM env defaults; unlimited if env also unset). */
  parserRpm?: number | null;
  outreachRpm?: number | null;
  sentTodayMsg: number;
  sentTodayNew: number;
  /** 0..4. 4 = warmup complete, operator's dailyMsgLimit is the only ceiling. */
  warmupStage: number;
  /** Set on first outbound; null = warmup clock hasn't started yet. */
  warmupStartedAt?: string | null;
  cooldownUntil: string | null;
  tags: string[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
