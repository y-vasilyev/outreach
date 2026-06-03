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
  warmupStage: number;
  warmupStartedAt?: string | null;
  cooldownUntil: string | null;
  tags: string[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
