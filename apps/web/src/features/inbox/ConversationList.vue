<script setup lang="ts">
import { computed } from 'vue';
import Avatar from '../../components/Avatar.vue';
import Tag from '../../components/Tag.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import { initials, truncate } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { ConversationListItem } from './types';

const props = defineProps<{
  items: ConversationListItem[];
  activeId?: string;
}>();

const emit = defineEmits<{ (e: 'pick', id: string): void }>();

interface Tab {
  id: 'all' | 'ai' | 'op' | 'meets';
  icon: 'list' | 'sparkle' | 'user' | 'flag';
  count: number;
}

const tabs = computed<Tab[]>(() => [
  { id: 'all', icon: 'list', count: props.items.length },
  { id: 'ai', icon: 'sparkle', count: props.items.filter((c) => (c.pendingSuggestions ?? 0) > 0).length },
  { id: 'op', icon: 'user', count: props.items.filter((c) => c.mode === 'manual').length },
  { id: 'meets', icon: 'flag', count: 0 },
]);

// Local quick-filter pill (all/ai/op/meets) — counts reflect whatever
// `props.items` was passed in, i.e. already narrowed by the inbox-level
// filters (`InboxFilters`). Clicking these tabs is still decorative;
// wiring them into a real client-side post-filter is a follow-up.
const activeFilter = computed(() => 'all');
</script>

<template>
  <div class="inbox-list" style="display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--paper-2); border-right: 1px solid var(--line);">
    <div style="height: var(--topbar); padding: 0 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); flex: none;">
      <span style="font-weight: 600; font-size: 13px;">Inbox</span>
      <span class="kbd">{{ items.length }}</span>
      <div style="flex: 1;" />
      <button class="btn ghost icon-only sm" title="Фильтр"><Icon name="filter" :size="12" /></button>
      <button class="btn ghost icon-only sm" title="Новый"><Icon name="plus" :size="12" /></button>
    </div>
    <div style="padding: 6px 8px; display: flex; gap: 4px; flex: none; border-bottom: 1px solid var(--line); overflow-x: auto; white-space: nowrap;">
      <button v-for="t in tabs" :key="t.id" :class="['chip', activeFilter === t.id ? 'applied accent' : '']" :title="t.id">
        <Icon :name="t.icon" :size="11" />
        <span class="v">{{ t.count }}</span>
      </button>
    </div>
    <div style="overflow: auto; flex: 1;">
      <template v-if="items.length === 0">
        <div class="center"><span style="color: var(--ink-3); font-size: 12px;">Диалогов нет</span></div>
      </template>
      <template v-else>
        <div
          v-for="t in items"
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
              <Pill v-if="t.mode === 'manual'" :state="'needs_op'" />
              <Pill v-else-if="(t.pendingSuggestions ?? 0) > 0" :state="'ai_suggesting'" />
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
