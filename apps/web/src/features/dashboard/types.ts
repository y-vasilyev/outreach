export interface DashboardData {
  channels: { total: number; new: number; scraping: number; extracted: number; failed: number };
  contacts: { total: number; reachableTg: number; manual: number };
  conversations: { active: number; assisted: number; manual: number; auto: number };
  campaigns: { running: number; paused: number };
  cost: { tokensToday: number; costTodayUsd: number; cost7dUsd: number };
  replyRate7d: number;
  recentActivity: Array<{
    id: string;
    type: 'channel_extracted' | 'message_sent' | 'reply' | 'escalation' | 'failed';
    title: string;
    subtitle?: string;
    at: string;
  }>;
}
