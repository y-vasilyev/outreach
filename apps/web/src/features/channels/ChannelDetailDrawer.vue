<script setup lang="ts">
import { computed } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import Drawer from '../../components/Drawer.vue';
import Pill from '../../components/Pill.vue';
import Tag from '../../components/Tag.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import ConfBar from '../../components/ConfBar.vue';
import Icon from '../../components/Icon.vue';
import Avatar from '../../components/Avatar.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { formatCompact, formatDateTime, truncate, initials } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { Channel } from './types';
import type { Contact } from '../contacts/types';

const props = defineProps<{ channel: Channel | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'action'): void }>();

const enabled = computed(() => !!props.channel);

const { data: contacts } = useQuery({
  queryKey: ['channel-contacts', () => props.channel?.id],
  queryFn: () => api.get<Contact[]>(`/contacts?channelId=${props.channel!.id}`),
  enabled,
});

const scrapeMut = useMutation({
  mutationFn: () => api.post<void>(`/channels/${props.channel!.id}/scrape`, {}),
  onSuccess: () => {
    toast.info('Скрейп перезапущен');
    emit('action');
  },
});

const channelKv = computed<KvItem[]>(() => {
  const c = props.channel;
  if (!c) return [];
  return [
    { label: 'Платформа', value: c.platform },
    { label: 'Подписчики', value: formatCompact(c.followers ?? null), mono: true },
    { label: 'Язык', value: c.language ?? '—' },
    { label: 'Источник', value: c.source ?? '—' },
    { label: 'Скрейп', value: formatDateTime(c.scrapedAt ?? null) },
  ];
});
</script>

<template>
  <Drawer :open="!!channel" :title="channel ? channel.title || channel.handle : ''" @close="emit('close')">
    <template v-if="channel" #head-actions>
      <Tag :platform="channel.platform" />
      <Pill :state="channel.status" />
      <button class="btn sm" @click="scrapeMut.mutate()" :disabled="scrapeMut.isPending.value">
        <span v-if="scrapeMut.isPending.value" class="spinner" />
        <Icon v-else name="refresh" :size="11" />
        <span>Перескрейпить</span>
      </button>
    </template>
    <template v-if="channel">
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px;">
        <Avatar :text="initials(channel.title || channel.handle)" size="xl" :color="avatarColor(channel.id)" />
        <div style="min-width: 0;">
          <div style="font-weight: 600; font-size: 16px; letter-spacing: -0.01em;" class="ellipsis">{{ channel.title || channel.handle }}</div>
          <div class="mono muted-2" style="font-size: 11.5px;">{{ channel.handle }}</div>
        </div>
      </div>

      <KeyValue :items="channelKv" />

      <div v-if="channel.analysis" class="card" style="margin-top: 16px;">
        <div class="card-head">
          <Icon name="sparkle" :size="12" /><span>Анализ канала</span>
        </div>
        <div class="card-body" style="display: flex; flex-wrap: wrap; gap: 6px;">
          <Pill v-if="channel.analysis.topic" state="ok" :label="`topic: ${channel.analysis.topic}`" :dot="false" />
          <Pill v-if="channel.analysis.tone" state="ghost" :label="`tone: ${channel.analysis.tone}`" :dot="false" />
          <Pill v-for="f in channel.analysis.red_flags ?? []" :key="f" state="closed_neg" :label="f" :dot="false" />
        </div>
      </div>

      <div v-if="channel.description" style="margin-top: 16px;">
        <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 6px; font-weight: 500;">Описание</div>
        <p style="font-size: 12.5px; color: var(--ink-2); white-space: pre-wrap; line-height: 1.55;">{{ truncate(channel.description, 1200) }}</p>
      </div>

      <div style="margin-top: 16px;">
        <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 6px; font-weight: 500;">
          Контакты ({{ (contacts ?? []).length }})
        </div>
        <div v-if="!contacts || contacts.length === 0" class="placeholder" style="margin-top: 6px; min-height: 60px;">
          Контакты ещё не извлечены
        </div>
        <div v-else style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
          <div
            v-for="c in contacts"
            :key="c.id"
            style="display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: var(--r-md); padding: 8px 12px;"
          >
            <div style="min-width: 0; flex: 1;">
              <div style="display: flex; gap: 6px; align-items: center;">
                <Pill :state="c.roleGuess" />
                <Tag>{{ c.type }}</Tag>
              </div>
              <div class="mono cell-strong ellipsis" style="font-size: 12px; margin-top: 4px;">{{ c.value }}</div>
            </div>
            <div style="text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <ConfBar :value="c.confidence" />
                <span class="mono muted-2" style="font-size: 10.5px;">{{ (c.confidence * 100).toFixed(0) }}%</span>
              </div>
              <Pill :state="c.status" />
            </div>
          </div>
        </div>
      </div>

      <div v-if="channel.lastError" class="card" style="margin-top: 16px; border-color: var(--bad-line); background: var(--bad-bg);">
        <div class="card-head" style="background: var(--bad-bg); color: var(--bad);">
          <Icon name="warn" :size="12" /><span>Последняя ошибка</span>
        </div>
        <div class="card-body mono" style="white-space: pre-wrap; font-size: 11.5px; color: var(--bad);">{{ channel.lastError }}</div>
      </div>
    </template>
  </Drawer>
</template>
