import { Fragment } from 'react';
import { Dialog, Transition } from '@headlessui/react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { Button } from '../../components/Button';
import { KeyValue } from '../../components/KeyValue';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatCompact, formatDateTime, truncate } from '../../lib/format';
import type { Channel } from './ChannelsPage';
import type { Contact } from '../contacts/ContactsPage';

interface Props {
  channel: Channel | null;
  onClose: () => void;
  onAction: () => void;
}

export function ChannelDetailDrawer({ channel, onClose, onAction }: Props) {
  const toast = useToast();
  const { data: contacts = [] } = useQuery({
    queryKey: ['channel-contacts', channel?.id],
    queryFn: () => api.get<Contact[]>(`/contacts?channelId=${channel!.id}`),
    enabled: !!channel,
  });

  const scrapeMut = useMutation({
    mutationFn: () => api.post<void>(`/channels/${channel!.id}/scrape`, {}),
    onSuccess: () => {
      toast.info('Скрейп перезапущен');
      onAction();
    },
  });

  return (
    <Transition.Root show={!!channel} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm" />
        </Transition.Child>
        <div className="fixed inset-0 overflow-hidden">
          <div className="pointer-events-none absolute inset-y-0 right-0 flex max-w-full">
            <Transition.Child
              as={Fragment}
              enter="transform transition ease-in-out duration-200"
              enterFrom="translate-x-full"
              enterTo="translate-x-0"
              leave="transform transition ease-in-out duration-150"
              leaveFrom="translate-x-0"
              leaveTo="translate-x-full"
            >
              <Dialog.Panel className="pointer-events-auto w-screen max-w-2xl">
                <div className="flex h-full flex-col bg-white shadow-pop">
                  {channel && (
                    <>
                      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge tone={platformTone(channel.platform)}>{channel.platform}</Badge>
                            <StatusDot status={channel.status} />
                          </div>
                          <Dialog.Title className="mt-2 truncate text-lg font-semibold text-slate-900">
                            {channel.title || channel.handle}
                          </Dialog.Title>
                          <div className="truncate font-mono text-xs text-slate-500">{channel.handle}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            leftIcon={<ArrowPathIcon className="h-4 w-4" />}
                            onClick={() => scrapeMut.mutate()}
                            loading={scrapeMut.isPending}
                          >
                            Перезапустить
                          </Button>
                          <button
                            onClick={onClose}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          >
                            <XMarkIcon className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin">
                        <KeyValue
                          items={[
                            { label: 'Подписчики', value: formatCompact(channel.followers ?? null) },
                            { label: 'Язык', value: channel.language ?? '—' },
                            { label: 'Источник', value: channel.source ?? '—' },
                            { label: 'Скрейп', value: formatDateTime(channel.scrapedAt ?? null) },
                          ]}
                        />
                        {channel.analysis && (
                          <div className="mt-6 card-padded">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Анализ канала
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2 text-xs">
                              {channel.analysis.topic && (
                                <Badge tone="indigo">topic: {channel.analysis.topic}</Badge>
                              )}
                              {channel.analysis.tone && (
                                <Badge tone="slate">tone: {channel.analysis.tone}</Badge>
                              )}
                              {channel.analysis.red_flags?.map((f) => (
                                <Badge key={f} tone="rose">
                                  {f}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {channel.description && (
                          <div className="mt-6">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Описание
                            </div>
                            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                              {truncate(channel.description, 1200)}
                            </p>
                          </div>
                        )}
                        <div className="mt-6">
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Контакты ({contacts.length})
                          </div>
                          <div className="mt-3 space-y-2">
                            {contacts.length === 0 ? (
                              <div className="rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500 ring-1 ring-slate-200">
                                Контакты ещё не извлечены
                              </div>
                            ) : (
                              contacts.map((c) => (
                                <div
                                  key={c.id}
                                  className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <Badge tone={roleTone(c.roleGuess)}>{c.roleGuess}</Badge>
                                      <Badge tone="slate">{c.type}</Badge>
                                    </div>
                                    <div className="mt-1 truncate font-mono text-sm text-slate-900">{c.value}</div>
                                  </div>
                                  <div className="text-right text-xs text-slate-500">
                                    <div>conf {(c.confidence * 100).toFixed(0)}%</div>
                                    <StatusDot status={c.status} />
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                        {channel.lastError && (
                          <div className="mt-6 rounded-xl bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">
                            <div className="font-semibold">Последняя ошибка</div>
                            <div className="mt-1 whitespace-pre-wrap text-xs">{channel.lastError}</div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}

function platformTone(p: string): 'sky' | 'rose' | 'gray' {
  if (p === 'telegram') return 'sky';
  if (p === 'instagram') return 'rose';
  if (p === 'youtube') return 'rose';
  return 'gray';
}

function roleTone(r: string): 'indigo' | 'emerald' | 'slate' | 'amber' | 'gray' {
  if (r === 'ad_manager') return 'indigo';
  if (r === 'owner') return 'emerald';
  if (r === 'bot') return 'amber';
  if (r === 'generic') return 'slate';
  return 'gray';
}
