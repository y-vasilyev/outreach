export interface TgAccount {
  id: string;
  label: string;
  phone: string;
  status: 'idle' | 'active' | 'cooldown' | 'banned' | 'need_auth';
  role: 'parser' | 'outreach' | 'both';
  dailyMsgLimit: number;
  dailyNewContactLimit: number;
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
