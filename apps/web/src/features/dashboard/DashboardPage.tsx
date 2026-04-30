import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowTrendingUpIcon,
  HashtagIcon,
  IdentificationIcon,
  ChatBubbleLeftRightIcon,
  CurrencyDollarIcon,
  PaperAirplaneIcon,
  ExclamationTriangleIcon,
  CheckBadgeIcon,
} from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { api } from '../../lib/api';
import { formatNumber, formatMoney, formatPct, formatRelative } from '../../lib/format';
import { Spinner } from '../../components/Spinner';
import { StatusDot } from '../../components/StatusDot';
import { cn } from '../../lib/cn';

interface DashboardData {
  channels: { total: number; new: number; scraping: number; extracted: number; failed: number };
  contacts: { total: number; reachable_tg: number; manual: number };
  conversations: { active: number; assisted: number; manual: number; auto: number };
  campaigns: { running: number; paused: number };
  cost: { tokens_today: number; cost_today_usd: number; cost_7d_usd: number };
  reply_rate_7d: number;
  recent_activity: Array<{
    id: string;
    type: 'channel_extracted' | 'message_sent' | 'reply' | 'escalation' | 'failed';
    title: string;
    subtitle?: string;
    at: string;
  }>;
}

const fallback: DashboardData = {
  channels: { total: 0, new: 0, scraping: 0, extracted: 0, failed: 0 },
  contacts: { total: 0, reachable_tg: 0, manual: 0 },
  conversations: { active: 0, assisted: 0, manual: 0, auto: 0 },
  campaigns: { running: 0, paused: 0 },
  cost: { tokens_today: 0, cost_today_usd: 0, cost_7d_usd: 0 },
  reply_rate_7d: 0,
  recent_activity: [],
};

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/metrics/dashboard'),
    refetchInterval: 30_000,
  });

  const d = data ?? fallback;

  return (
    <div>
      <PageHeader
        title="Дашборд"
        description="Сводка по каналам, контактам, диалогам и стоимости агентов."
      />
      {isLoading && !data ? (
        <div className="flex h-48 items-center justify-center text-slate-500">
          <Spinner className="text-brand-500" />
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Каналы"
              value={formatNumber(d.channels.total)}
              icon={<HashtagIcon className="h-5 w-5" />}
              hint={`${formatNumber(d.channels.extracted)} с контактами`}
              tone="indigo"
              to="/channels"
            />
            <StatCard
              label="Контакты"
              value={formatNumber(d.contacts.total)}
              icon={<IdentificationIcon className="h-5 w-5" />}
              hint={`${formatNumber(d.contacts.reachable_tg)} TG · ${formatNumber(d.contacts.manual)} manual`}
              tone="emerald"
              to="/contacts"
            />
            <StatCard
              label="Активные диалоги"
              value={formatNumber(d.conversations.active)}
              icon={<ChatBubbleLeftRightIcon className="h-5 w-5" />}
              hint={`Assisted ${d.conversations.assisted} · Manual ${d.conversations.manual}`}
              tone="violet"
              to="/inbox"
            />
            <StatCard
              label="Стоимость / 7 дн."
              value={formatMoney(d.cost.cost_7d_usd)}
              icon={<CurrencyDollarIcon className="h-5 w-5" />}
              hint={`${formatMoney(d.cost.cost_today_usd)} сегодня`}
              tone="amber"
            />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="card-padded lg:col-span-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">Воронка каналов</h2>
                <Link to="/channels" className="text-xs font-medium text-brand-600 hover:text-brand-500">
                  Открыть список →
                </Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <FunnelStep status="new" count={d.channels.new} />
                <FunnelStep status="scraping" count={d.channels.scraping} />
                <FunnelStep status="extracted" count={d.channels.extracted} />
                <FunnelStep status="failed" count={d.channels.failed} />
                <FunnelStep status="ready" count={d.channels.total - d.channels.new - d.channels.scraping - d.channels.failed} />
              </div>
              <div className="mt-6 h-32 rounded-xl bg-gradient-to-br from-brand-50 to-slate-50 ring-1 ring-slate-200 flex items-center justify-center text-xs text-slate-400">
                Здесь будет график активности (placeholder)
              </div>
            </div>

            <div className="card-padded">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">KPI диалогов</h2>
                <ArrowTrendingUpIcon className="h-4 w-4 text-slate-400" />
              </div>
              <ul className="mt-4 space-y-3">
                <KpiRow label="Reply-rate (7д)" value={formatPct(d.reply_rate_7d)} tone="emerald" />
                <KpiRow label="Кампании running" value={formatNumber(d.campaigns.running)} tone="indigo" />
                <KpiRow label="Tokens сегодня" value={formatNumber(d.cost.tokens_today)} tone="slate" />
                <KpiRow label="Conv. на оператора" value={formatNumber(d.conversations.manual)} tone="violet" />
              </ul>
            </div>
          </div>

          <div className="card-padded">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Последняя активность</h2>
              <Link to="/audit" className="text-xs font-medium text-brand-600 hover:text-brand-500">
                Полный аудит →
              </Link>
            </div>
            <div className="mt-4 divide-y divide-slate-100">
              {d.recent_activity.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">Активности пока нет</div>
              ) : (
                d.recent_activity.map((ev) => <ActivityRow key={ev.id} ev={ev} />)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  hint,
  tone,
  to,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  hint?: string;
  tone: 'indigo' | 'emerald' | 'amber' | 'violet';
  to?: string;
}) {
  const toneCls =
    tone === 'indigo'
      ? 'bg-brand-50 text-brand-700'
      : tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-800'
      : 'bg-violet-50 text-violet-700';
  const inner = (
    <div className="card-padded h-full transition-shadow hover:shadow-pop">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
        </div>
        <div className={cn('rounded-xl p-2', toneCls)}>{icon}</div>
      </div>
      {hint && <div className="mt-3 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

function FunnelStep({ status, count }: { status: string; count: number }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <StatusDot status={status} />
      <div className="mt-2 text-xl font-semibold text-slate-900">{formatNumber(count)}</div>
    </div>
  );
}

function KpiRow({ label, value, tone }: { label: string; value: string; tone: 'emerald' | 'indigo' | 'slate' | 'violet' }) {
  const toneCls =
    tone === 'emerald'
      ? 'text-emerald-600'
      : tone === 'indigo'
      ? 'text-brand-600'
      : tone === 'violet'
      ? 'text-violet-600'
      : 'text-slate-600';
  return (
    <li className="flex items-center justify-between">
      <span className="text-sm text-slate-600">{label}</span>
      <span className={cn('text-sm font-semibold', toneCls)}>{value}</span>
    </li>
  );
}

function ActivityRow({ ev }: { ev: DashboardData['recent_activity'][number] }) {
  const Icon =
    ev.type === 'message_sent'
      ? PaperAirplaneIcon
      : ev.type === 'reply'
      ? ChatBubbleLeftRightIcon
      : ev.type === 'failed'
      ? ExclamationTriangleIcon
      : ev.type === 'escalation'
      ? ExclamationTriangleIcon
      : CheckBadgeIcon;
  const tone =
    ev.type === 'failed'
      ? 'text-rose-600 bg-rose-50'
      : ev.type === 'escalation'
      ? 'text-amber-700 bg-amber-50'
      : ev.type === 'reply'
      ? 'text-emerald-600 bg-emerald-50'
      : 'text-brand-600 bg-brand-50';
  return (
    <div className="flex items-start gap-3 py-3">
      <div className={cn('mt-0.5 rounded-lg p-2', tone)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900 truncate">{ev.title}</div>
        {ev.subtitle && <div className="text-xs text-slate-500">{ev.subtitle}</div>}
      </div>
      <div className="text-xs text-slate-400 whitespace-nowrap">{formatRelative(ev.at)}</div>
    </div>
  );
}
