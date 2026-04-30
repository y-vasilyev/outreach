import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CommandLineIcon, BoltIcon, ArrowRightIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Badge } from '../../components/Badge';
import { Spinner } from '../../components/Spinner';
import { EmptyState } from '../../components/EmptyState';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';

export interface AgentSummary {
  id: string;
  name: string;
  role?: string;
  description?: string;
  endpoint?: { id: string; name: string; provider: string };
  fallback_endpoint?: { id: string; name: string } | null;
  model: string;
  enabled: boolean;
  version: number;
  variables?: string[];
  updated_at: string;
}

const agentLabels: Record<string, string> = {
  channel_analyzer: 'Channel Analyzer',
  contact_extractor: 'Contact Extractor',
  contact_prioritizer: 'Contact Prioritizer',
  approach_strategist: 'Approach Strategist',
  opening_composer: 'Opening Composer',
  reply_composer: 'Reply Composer',
  intent_classifier: 'Intent Classifier',
  safety_filter: 'Safety Filter',
  handoff_decider: 'Handoff Decider',
  conversation_summarizer: 'Conversation Summarizer',
  next_action_planner: 'Next Action Planner',
  quality_reviewer: 'Quality Reviewer',
};

const agentClass: Record<string, 'cheap' | 'medium' | 'strong'> = {
  channel_analyzer: 'medium',
  contact_extractor: 'medium',
  contact_prioritizer: 'cheap',
  approach_strategist: 'medium',
  opening_composer: 'strong',
  reply_composer: 'strong',
  intent_classifier: 'cheap',
  safety_filter: 'cheap',
  handoff_decider: 'cheap',
  conversation_summarizer: 'medium',
  next_action_planner: 'medium',
  quality_reviewer: 'strong',
};

export function AgentsPage() {
  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<AgentSummary[]>('/agents'),
  });

  return (
    <div>
      <PageHeader
        title="Агенты"
        description="Карточки всех агентов с endpoint-ом, моделью и текущей версией промптов."
      />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="text-brand-500" />
        </div>
      ) : agents.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Агентов нет"
            description="Сидер должен заполнить agent_config дефолтами при первом запуске."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => {
            const cls = agentClass[a.name] ?? 'medium';
            return (
              <Link
                key={a.id}
                to={`/agents/${a.id}`}
                className="group card-padded transition-shadow hover:shadow-pop"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                        <CommandLineIcon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-900">
                          {agentLabels[a.name] ?? a.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-slate-500">{a.name}</div>
                      </div>
                    </div>
                  </div>
                  <Badge tone={cls === 'strong' ? 'indigo' : cls === 'medium' ? 'sky' : 'slate'}>
                    {cls}
                  </Badge>
                </div>
                <p className="mt-3 line-clamp-2 text-sm text-slate-600">
                  {a.description ?? a.role ?? 'Без описания.'}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <Field label="Endpoint" value={a.endpoint?.name ?? '—'} />
                  <Field label="Модель" value={a.model} mono />
                  <Field label="Fallback" value={a.fallback_endpoint?.name ?? '—'} />
                  <Field label="Версия" value={`v${a.version}`} />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        a.enabled ? 'bg-emerald-500' : 'bg-slate-300',
                      )}
                    />
                    {a.enabled ? 'enabled' : 'disabled'}
                    <span className="text-slate-300">·</span>
                    <span>upd {formatDateTime(a.updated_at)}</span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-brand-600 group-hover:text-brand-500">
                    Открыть <ArrowRightIcon className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <div className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <BoltIcon className="h-4 w-4 text-brand-500" />
          <span>
            Подсказка: переменные <code className="font-mono text-xs">{`{{var}}`}</code> в промптах подсвечиваются.
            Все объявленные `variables` агента должны быть использованы или объявлены опциональными.
          </span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200/60">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn('truncate text-slate-900', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}
