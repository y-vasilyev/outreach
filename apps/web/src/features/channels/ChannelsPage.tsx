import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PlusIcon,
  ArrowDownTrayIcon,
  MagnifyingGlassIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { DataTable, type Column } from '../../components/DataTable';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { ChannelImportDialog } from './ChannelImportDialog';
import { ChannelDetailDrawer } from './ChannelDetailDrawer';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatCompact, formatRelative } from '../../lib/format';

export interface Channel {
  id: string;
  platform: 'telegram' | 'instagram' | 'youtube';
  handle: string;
  title: string;
  description?: string;
  followers?: number;
  language?: string;
  status: string;
  /** Prisma-style include from `findMany`. */
  _count?: { contacts: number };
  source?: string;
  scrapedAt?: string;
  createdAt: string;
  updatedAt?: string;
  /** `red_flags` is intentional snake_case in the analysis schema. */
  analysis?: { topic?: string; tone?: string; red_flags?: string[] } | null;
  lastError?: string | null;
}

export function ChannelsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Channel | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['channels', { search, platform, status }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set('q', search);
      if (platform) qs.set('platform', platform);
      if (status) qs.set('status', status);
      return api.get<{ items: Channel[]; total: number } | Channel[]>(`/channels?${qs.toString()}`);
    },
  });

  const channels = useMemo<Channel[]>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.items;
  }, [data]);

  const scrapeMut = useMutation({
    mutationFn: (id: string) => api.post<void>(`/channels/${id}/scrape`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      toast.info('Перезапуск скрейпа поставлен в очередь');
    },
  });

  const columns: Column<Channel>[] = [
    {
      key: 'channel',
      header: 'Канал',
      cell: (r) => (
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-700">
            {(r.title || r.handle || '?').slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-900">{r.title || r.handle}</div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Badge tone={platformTone(r.platform)}>{r.platform}</Badge>
              <span className="truncate font-mono">{r.handle}</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (r) => <StatusDot status={r.status} />,
    },
    {
      key: 'topic',
      header: 'Тема',
      cell: (r) => (
        <div className="text-xs text-slate-700">
          {r.analysis?.topic ? (
            <Badge tone="indigo">{r.analysis.topic}</Badge>
          ) : (
            <span className="text-slate-400">—</span>
          )}
          {r.analysis?.red_flags?.length ? (
            <Badge tone="rose" className="ml-1">
              red flags
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'followers',
      header: 'Подписчики',
      align: 'right',
      cell: (r) => <span className="text-sm tabular-nums text-slate-700">{formatCompact(r.followers ?? null)}</span>,
    },
    {
      key: 'contacts',
      header: 'Контакты',
      align: 'right',
      cell: (r) => (
        <span className="text-sm tabular-nums text-slate-700">{r._count?.contacts ?? 0}</span>
      ),
    },
    {
      key: 'scraped',
      header: 'Скрейп',
      cell: (r) => <span className="text-xs text-slate-500">{formatRelative(r.scrapedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={(e) => {
              e.stopPropagation();
              scrapeMut.mutate(r.id);
            }}
            title="Перезапустить скрейп"
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={(e) => {
              e.stopPropagation();
              setSelected(r);
            }}
            title="Открыть"
          >
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Каналы"
        description="Все загруженные каналы. Один канал — N контактов с приоритетом."
        actions={
          <>
            <Button
              variant="secondary"
              leftIcon={<ArrowDownTrayIcon className="h-4 w-4" />}
              onClick={() => toast.info('Экспорт CSV', 'Скачивание начнётся через секунду')}
            >
              Экспорт CSV
            </Button>
            <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => setImportOpen(true)}>
              Импорт каналов
            </Button>
          </>
        }
      />

      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Input
            placeholder="Поиск по handle / названию"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
          />
          <Select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            options={[
              { value: '', label: 'Все платформы' },
              { value: 'telegram', label: 'Telegram' },
              { value: 'instagram', label: 'Instagram' },
              { value: 'youtube', label: 'YouTube' },
            ]}
          />
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Любой статус' },
              { value: 'new', label: 'New' },
              { value: 'scraping', label: 'Scraping' },
              { value: 'scraped', label: 'Scraped' },
              { value: 'extracting', label: 'Extracting' },
              { value: 'extracted', label: 'Extracted' },
              { value: 'ready', label: 'Ready' },
              { value: 'failed', label: 'Failed' },
              { value: 'disqualified', label: 'Disqualified' },
            ]}
          />
          <div className="text-right text-xs text-slate-500 sm:self-end">
            Найдено: <span className="font-medium text-slate-900">{channels.length}</span>
          </div>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={channels}
        loading={isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelected(r)}
        emptyTitle="Каналов пока нет"
        emptyDescription="Импортируйте список или вставьте handle-ы вручную."
        emptyAction={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => setImportOpen(true)}>
            Импорт
          </Button>
        }
      />

      <ChannelImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['channels'] });
          setImportOpen(false);
          toast.success('Каналы поставлены в очередь скрейпа');
        }}
      />
      <ChannelDetailDrawer
        channel={selected}
        onClose={() => setSelected(null)}
        onAction={() => qc.invalidateQueries({ queryKey: ['channels'] })}
      />
    </div>
  );
}

function platformTone(p: string): 'sky' | 'rose' | 'violet' | 'gray' {
  if (p === 'telegram') return 'sky';
  if (p === 'instagram') return 'rose';
  if (p === 'youtube') return 'rose';
  return 'gray';
}

