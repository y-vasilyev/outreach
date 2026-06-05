<script setup lang="ts">
import { computed, ref } from 'vue';
import Avatar from '../../components/Avatar.vue';
import Tag from '../../components/Tag.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import { initials, truncate } from '../../lib/format';
import { avatarColor, type PillClass } from '../../lib/state';
import type { ConversationListItem } from './types';

const props = defineProps<{
  items: ConversationListItem[];
  activeId?: string;
}>();

const emit = defineEmits<{ (e: 'pick', id: string): void }>();

type QuickFilterId = 'all' | 'ai' | 'op' | 'meets';

interface Tab {
  id: QuickFilterId;
  icon: 'list' | 'sparkle' | 'user' | 'flag';
  count: number;
}

interface ListStage {
  state?: string;
  label?: string;
  cls?: PillClass;
}

const activeFilter = ref<QuickFilterId>('all');

function matchesQuickFilter(item: ConversationListItem, filter: QuickFilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'ai') return (item.pendingSuggestions ?? 0) > 0;
  if (filter === 'op') return item.mode === 'manual';
  return false;
}

const tabs = computed<Tab[]>(() => [
  { id: 'all', icon: 'list', count: props.items.length },
  { id: 'ai', icon: 'sparkle', count: props.items.filter((c) => (c.pendingSuggestions ?? 0) > 0).length },
  { id: 'op', icon: 'user', count: props.items.filter((c) => c.mode === 'manual').length },
  { id: 'meets', icon: 'flag', count: 0 },
]);

// Local quick-filter pill (all/ai/op/meets) runs as a client-side post-filter
// over `props.items`, which is already narrowed by inbox-level URL/API filters.
const visibleItems = computed(() => props.items.filter((item) => matchesQuickFilter(item, activeFilter.value)));

function toMillis(value?: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function hasUnreadInbound(item: ConversationListItem): boolean {
  if ((item.unread ?? 0) > 0) return true;
  const inbound = toMillis(item.lastInboundAt);
  if (!inbound) return false;
  const read = toMillis(item.lastReadAt);
  return !read || inbound > read;
}

function isWaitingForReply(item: ConversationListItem): boolean {
  const outbound = toMillis(item.lastOutboundAt);
  if (!outbound) return false;
  const inbound = toMillis(item.lastInboundAt);
  return !inbound || outbound > inbound;
}

function listStage(item: ConversationListItem): ListStage {
  if (item.status !== 'active') return { state: item.status };
  if (hasUnreadInbound(item)) return { state: 'replied' };
  if ((item.pendingSuggestions ?? 0) > 0) return { state: 'ai_suggesting' };
  if (item.mode === 'manual') return { state: 'needs_op' };
  if (isWaitingForReply(item)) return { label: 'ждём ответ', cls: 'ghost' };
  return { label: 'нет касаний', cls: 'ghost' };
}
</script>

<template>
  <div class="inbox-list" style="display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--paper-2); border-right: 1px solid var(--line);">
    <div style="height: var(--topbar); padding: 0 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); flex: none;">
      <span style="font-weight: 600; font-size: 13px;">Inbox</span>
      <span class="kbd">{{ visibleItems.length }}</span>
      <div style="flex: 1;" />
      <button class="btn ghost icon-only sm" title="Фильтр"><Icon name="filter" :size="12" /></button>
      <button class="btn ghost icon-only sm" title="Новый"><Icon name="plus" :size="12" /></button>
    </div>
    <div style="padding: 6px 8px; display: flex; gap: 4px; flex: none; border-bottom: 1px solid var(--line); overflow-x: auto; white-space: nowrap;">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        :class="['chip', activeFilter === t.id ? 'applied accent' : '']"
        :title="t.id"
        :aria-pressed="activeFilter === t.id"
        @click="activeFilter = t.id"
      >
        <Icon :name="t.icon" :size="11" />
        <span class="v">{{ t.count }}</span>
      </button>
    </div>
    <div style="overflow: auto; flex: 1;">
      <template v-if="visibleItems.length === 0">
        <div class="center"><span style="color: var(--ink-3); font-size: 12px;">Диалогов нет</span></div>
      </template>
      <template v-else>
        <div
          v-for="t in visibleItems"
          :key="t.id"
          @click="emit('pick', t.id)"
          :style="{
            padding: '9px 12px',
            borderBottom: '1px solid var(--line)',
            cursor: 'pointer',
            background: t.id === activeId ? 'var(--paper)' : 'transparent',
            borderLeft: `2px solid ${t.id === activeId ? 'var(--ink)' : 'transparent'}`,
            display: 'flex',
            gap: '10px',
          }"
        >
          <Avatar
            :text="initials(t.contact?.channel?.title || t.contact?.value || '??')"
            :color="avatarColor(t.id)"
          />
          <div style="min-width: 0; flex: 1;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-weight: 500; font-size: 12.5px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;">
                {{ t.contact?.channel?.title || t.contact?.value || 'Без названия' }}
              </span>
              <span v-if="t.lastMessageAt" style="font-size: 10.5px; color: var(--ink-4); font-family: var(--font-mono);">{{ formatLastTime(t.lastMessageAt) }}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 2px;">
              <Tag v-if="t.contact?.channel?.platform" :platform="t.contact.channel.platform" />
              <span class="muted-2" style="font-size: 10.5px;">{{ t.contact?.channel?.handle || t.contact?.value || '' }}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; margin-top: 5px;">
              <span style="font-size: 11.5px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;">{{ truncate(t.lastMessageText || '', 80) }}</span>
              <span v-if="(t.unread ?? 0) > 0" :style="{
                minWidth: '16px',
                height: '16px',
                padding: '0 4px',
                borderRadius: '999px',
                background: 'var(--accent)',
                color: 'white',
                fontSize: '10px',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }">{{ t.unread }}</span>
            </div>
            <div style="margin-top: 5px; display: flex; gap: 6px; align-items: center;">
              <Pill :state="t.status" />
              <Pill
                :state="listStage(t).state"
                :label="listStage(t).label"
                :cls="listStage(t).cls"
              />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
function formatLastTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(d);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчера';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short' }).format(d);
}
</script>
