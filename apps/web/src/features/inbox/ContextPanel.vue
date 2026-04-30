<script setup lang="ts">
import { computed } from 'vue';
import Avatar from '../../components/Avatar.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import { formatRelative, initials, formatNumber } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { ConversationDetail, Suggestion } from './types';

const props = defineProps<{
  conversation: ConversationDetail;
  suggestions: Suggestion[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const channel = computed(() => props.conversation.contact?.channel ?? null);
const contact = computed(() => props.conversation.contact ?? null);

const channelKv = computed<KvItem[]>(() => {
  const ch = channel.value;
  const out: KvItem[] = [];
  if (ch?.topic) out.push({ label: 'Тема', value: ch.topic });
  if (ch?.platform) out.push({ label: 'Платформа', value: ch.platform });
  if (ch?.followers != null) out.push({ label: 'Подписчики', value: formatNumber(ch.followers), mono: true });
  if (ch?.handle) out.push({ label: 'Handle', value: ch.handle, mono: true });
  return out;
});

const traceItems = computed(() => {
  const seen = new Map<string, { agent: string; at: string; intent?: string; risk?: number; score?: number }>();
  for (const s of props.suggestions.slice(0, 8)) {
    if (!seen.has(s.agentName)) {
      seen.set(s.agentName, {
        agent: s.agentName,
        at: s.createdAt,
        intent: s.meta?.intent_target,
        risk: s.meta?.risk_score,
        score: s.score,
      });
    }
  }
  return Array.from(seen.values());
});
</script>

<template>
  <div style="border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--paper-2); overflow: auto;">
    <div style="height: var(--topbar); padding: 0 14px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); flex: none;">
      <span style="font-weight: 600; font-size: 12px;">Контекст</span>
      <div style="flex: 1;" />
      <button class="btn ghost icon-only sm" @click="emit('close')"><Icon name="x" :size="12" /></button>
    </div>

    <div v-if="channel" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 10px;">
        <Avatar :text="initials(channel.title || channel.handle)" size="xl" :color="avatarColor(channel.id || channel.handle || 'ch')" />
        <div style="min-width: 0;">
          <div class="ellipsis" style="font-weight: 600; font-size: 13px;">{{ channel.title || channel.handle }}</div>
          <div class="muted ellipsis" style="font-size: 11px;">{{ channel.handle }} · {{ channel.platform }}</div>
        </div>
      </div>
      <KeyValue :items="channelKv" />
    </div>

    <div v-if="contact" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 8px; font-weight: 500;">Контакт</div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <Avatar :text="initials(contact.value)" size="lg" :color="avatarColor(contact.id)" />
        <div style="flex: 1; min-width: 0;">
          <div class="ellipsis" style="font-weight: 500; font-size: 12.5px;">{{ contact.value }}</div>
          <div v-if="contact.channel?.handle" class="mono muted ellipsis" style="font-size: 11px;">{{ contact.channel.handle }}</div>
        </div>
        <Pill v-if="contact.roleGuess" :state="contact.roleGuess" />
      </div>
    </div>

    <div v-if="traceItems.length" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 8px; font-weight: 500;">Что сделал ИИ</div>
      <div style="position: relative;">
        <div style="position: absolute; left: 5px; top: 4px; bottom: 4px; width: 1px; background: var(--line);" />
        <div v-for="(t, i) in traceItems" :key="i" style="display: flex; gap: 10px; margin-bottom: 10px; position: relative;">
          <div style="width: 11px; height: 11px; border-radius: 999px; background: var(--accent); border: 2px solid var(--paper-2); flex: none; margin-top: 3px; z-index: 1;" />
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="ellipsis" style="font-size: 11.5px; font-weight: 500;">{{ t.agent }}</span>
              <span class="mono muted-2" style="font-size: 10px;">{{ formatRelative(t.at) }}</span>
            </div>
            <div style="font-size: 11px; color: var(--ink-3); margin-top: 1px;">
              <template v-if="t.intent">intent: <span class="mono">{{ t.intent }}</span></template>
              <template v-if="t.risk != null"><span v-if="t.intent"> · </span>risk <span class="mono">{{ Math.round(t.risk * 100) }}%</span></template>
              <template v-else-if="t.score != null"><span v-if="t.intent"> · </span>conf <span class="mono">{{ Math.round(t.score * 100) }}%</span></template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div style="padding: 12px 14px;">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 8px; font-weight: 500;">Триггеры эскалации</div>
      <div style="display: flex; flex-direction: column; gap: 4px; font-size: 11.5px;">
        <div style="display: flex; justify-content: space-between;"><span class="muted">Режим</span><Pill :state="conversation.mode" /></div>
        <div style="display: flex; justify-content: space-between;"><span class="muted">Статус</span><Pill :state="conversation.status" /></div>
        <div v-if="conversation.lastInboundAt" style="display: flex; justify-content: space-between;"><span class="muted">Последний входящий</span><span class="mono">{{ formatRelative(conversation.lastInboundAt) }}</span></div>
      </div>
    </div>
  </div>
</template>
