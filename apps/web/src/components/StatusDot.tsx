import { Badge, type BadgeTone } from './Badge';

const statusToneMap: Record<string, BadgeTone> = {
  idle: 'gray',
  new: 'gray',
  draft: 'gray',
  scraping: 'sky',
  scraped: 'sky',
  extracting: 'sky',
  extracted: 'sky',
  active: 'emerald',
  ready: 'emerald',
  done: 'emerald',
  finished: 'emerald',
  ok: 'emerald',
  running: 'emerald',
  qualified: 'emerald',
  contacted: 'sky',
  paused: 'amber',
  cooldown: 'amber',
  warmup: 'amber',
  pending: 'amber',
  banned: 'rose',
  failed: 'rose',
  invalid: 'rose',
  blocked: 'rose',
  disqualified: 'rose',
  need_auth: 'violet',
  manual: 'violet',
  assisted: 'violet',
  auto: 'indigo',
};

const statusLabel: Record<string, string> = {
  idle: 'Idle',
  new: 'New',
  draft: 'Draft',
  scraping: 'Scraping',
  scraped: 'Scraped',
  extracting: 'Extracting',
  extracted: 'Extracted',
  active: 'Active',
  ready: 'Ready',
  done: 'Done',
  finished: 'Finished',
  ok: 'OK',
  running: 'Running',
  paused: 'Paused',
  cooldown: 'Cooldown',
  warmup: 'Warmup',
  pending: 'Pending',
  banned: 'Banned',
  failed: 'Failed',
  invalid: 'Invalid',
  blocked: 'Blocked',
  disqualified: 'Disqualified',
  need_auth: 'Need auth',
  manual: 'Manual',
  assisted: 'Assisted',
  auto: 'Auto',
  qualified: 'Qualified',
  contacted: 'Contacted',
};

export function StatusDot({ status, label }: { status: string; label?: string }) {
  const tone = statusToneMap[status] ?? 'gray';
  return (
    <Badge tone={tone} dot>
      {label ?? statusLabel[status] ?? status}
    </Badge>
  );
}
