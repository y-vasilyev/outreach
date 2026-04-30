export interface CampaignSchedule {
  tz?: string;
  workHours?: { start: string; end: string };
  days?: number[];
  maxPerDayPerAccount?: number;
}

export interface Campaign {
  id: string;
  name: string;
  goalText: string;
  valueProp: string;
  status: 'draft' | 'running' | 'paused' | 'finished';
  defaultMode: 'auto' | 'assisted' | 'manual';
  targetFilter?: Record<string, unknown>;
  outreachAccountPool?: string[];
  schedule?: CampaignSchedule;
  agentOverrides?: Record<string, unknown>;
  metrics?: { sent: number; replies: number; replyRate: number; qualified: number };
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPreviewItem {
  contactId: string;
  contactValue: string;
  channelTitle?: string;
  drafts: { text: string; riskScore?: number; rationale?: string }[];
  blocked?: { reasons: string[] };
}
