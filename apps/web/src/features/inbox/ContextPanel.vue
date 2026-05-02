<script setup lang="ts">
import { computed, ref } from 'vue';
import Avatar from '../../components/Avatar.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import KeyValue, { type KvItem } from '../../components/KeyValue.vue';
import { formatRelative, initials, formatNumber } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { ConversationDetail, Suggestion, ConversationChannel } from './types';

const props = defineProps<{
  conversation: ConversationDetail;
  suggestions: Suggestion[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const channel = computed(() => props.conversation.contact?.channel ?? null);
const contact = computed(() => props.conversation.contact ?? null);
const analysis = computed(() => channel.value?.analysis ?? null);

const channelKv = computed<KvItem[]>(() => {
  const ch = channel.value;
  const a = analysis.value;
  const out: KvItem[] = [];
  if (a?.topic) out.push({ label: 'Тема', value: a.topic });
  if (a?.audience) out.push({ label: 'Аудитория', value: a.audience });
  if (a?.format) out.push({ label: 'Формат', value: a.format });
  if (a?.tone) out.push({ label: 'Тон', value: a.tone });
  if (a?.language) out.push({ label: 'Язык', value: a.language });
  if (ch?.platform) out.push({ label: 'Платформа', value: ch.platform });
  if (ch?.followers != null) out.push({ label: 'Подписчики', value: formatNumber(ch.followers), mono: true });
  if (ch?.handle) out.push({ label: 'Handle', value: ch.handle, mono: true });
  return out;
});

const ownerHint = computed(() => analysis.value?.owner_signals?.owner_hint ?? null);
const isPersonalBrand = computed(() => analysis.value?.owner_signals?.is_personal_brand === true);
const redFlags = computed<string[]>(() => analysis.value?.red_flags ?? []);

function platformProfileUrl(ch: ConversationChannel | null): string | null {
  if (!ch?.handle) return null;
  const h = ch.handle.replace(/^@/, '');
  switch (ch.platform) {
    case 'telegram':
      return `https://t.me/${h}`;
    case 'instagram':
      return `https://instagram.com/${h}`;
    case 'youtube':
      return h.startsWith('@') ? `https://www.youtube.com/${h}` : `https://www.youtube.com/@${h}`;
    default:
      return null;
  }
}

const channelUrl = computed(() => platformProfileUrl(channel.value));

interface ChannelLink {
  href: string;
  label: string;
  isTg: boolean;
}

function classifyLink(raw: string): ChannelLink | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let href = trimmed;
  if (!/^https?:\/\//i.test(href)) {
    if (href.startsWith('@')) href = `https://t.me/${href.slice(1)}`;
    else if (/^t\.me\//i.test(href)) href = `https://${href}`;
    else if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(href)) href = `mailto:${href}`;
    else href = `https://${href}`;
  }
  const isTg = /(?:^|\/\/)(?:t\.me|telegram\.me)\//i.test(href);
  let label = trimmed.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (label.length > 48) label = `${label.slice(0, 47)}…`;
  return { href, label, isTg };
}

const channelLinks = computed<ChannelLink[]>(() => {
  const links = channel.value?.links ?? [];
  const seen = new Set<string>();
  const out: ChannelLink[] = [];
  for (const raw of links) {
    const link = classifyLink(raw);
    if (!link) continue;
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  // TG profile links go first — they're what the operator usually wants to open.
  out.sort((a, b) => Number(b.isTg) - Number(a.isTg));
  return out;
});

const descExpanded = ref(false);
const DESC_PREVIEW = 280;
const descRaw = computed(() => channel.value?.description ?? '');
const descIsLong = computed(() => descRaw.value.length > DESC_PREVIEW);
const descShown = computed(() =>
  !descIsLong.value || descExpanded.value
    ? descRaw.value
    : `${descRaw.value.slice(0, DESC_PREVIEW)}…`,
);

const contactDisplayName = computed(() => {
  const c = contact.value;
  if (!c) return '';
  const parts = [c.tgFirstName, c.tgLastName].filter((v): v is string => !!v && v.length > 0);
  if (parts.length > 0) return parts.join(' ');
  return c.value;
});

const contactTgUrl = computed(() => {
  const u = contact.value?.tgUsername;
  return u ? `https://t.me/${u.replace(/^@/, '')}` : null;
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
        <div style="min-width: 0; flex: 1;">
          <div class="ellipsis" style="font-weight: 600; font-size: 13px;">{{ channel.title || channel.handle }}</div>
          <div class="muted ellipsis" style="font-size: 11px;">{{ channel.handle }} · {{ channel.platform }}</div>
        </div>
        <a
          v-if="channelUrl"
          :href="channelUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="btn ghost icon-only sm"
          :title="`Открыть ${channel.platform}`"
        >
          <Icon name="link" :size="12" />
        </a>
      </div>
      <KeyValue :items="channelKv" />
      <div v-if="isPersonalBrand || ownerHint" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
        <span v-if="isPersonalBrand" style="font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--paper-3); border: 1px solid var(--line); color: var(--ink-3);">персональный бренд</span>
        <span v-if="ownerHint" style="font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--paper-3); border: 1px solid var(--line); color: var(--ink-3);">автор: {{ ownerHint }}</span>
      </div>
      <div v-if="redFlags.length" style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">
        <span
          v-for="(f, i) in redFlags"
          :key="i"
          style="font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn);"
        >⚠ {{ f }}</span>
      </div>
    </div>

    <div v-if="descRaw" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 6px; font-weight: 500;">Описание канала</div>
      <div style="font-size: 12px; color: var(--ink-2); line-height: 1.5; white-space: pre-wrap; word-break: break-word;">{{ descShown }}</div>
      <button
        v-if="descIsLong"
        class="btn ghost sm"
        style="margin-top: 6px; padding: 2px 6px; font-size: 11px;"
        @click="descExpanded = !descExpanded"
      >
        {{ descExpanded ? 'Свернуть' : 'Показать всё' }}
      </button>
    </div>

    <div v-if="channelLinks.length" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 8px; font-weight: 500;">Ссылки из канала</div>
      <div style="display: flex; flex-direction: column; gap: 4px;">
        <a
          v-for="l in channelLinks"
          :key="l.href"
          :href="l.href"
          target="_blank"
          rel="noopener noreferrer"
          class="ellipsis"
          style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--accent); text-decoration: none;"
          :title="l.href"
        >
          <Icon :name="l.isTg ? 'send' : 'link'" :size="11" />
          <span class="ellipsis mono">{{ l.label }}</span>
          <span
            v-if="l.isTg"
            style="font-size: 10px; padding: 1px 5px; border-radius: 999px; background: var(--paper-3); border: 1px solid var(--line); color: var(--ink-4); flex: none;"
          >TG</span>
        </a>
      </div>
    </div>

    <div v-if="contact" style="padding: 12px 14px; border-bottom: 1px solid var(--line);">
      <div style="font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-4); margin-bottom: 8px; font-weight: 500;">Контакт</div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <Avatar :text="initials(contactDisplayName)" size="lg" :color="avatarColor(contact.id)" />
        <div style="flex: 1; min-width: 0;">
          <div class="ellipsis" style="font-weight: 500; font-size: 12.5px;">{{ contactDisplayName }}</div>
          <a
            v-if="contactTgUrl"
            :href="contactTgUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="mono ellipsis"
            style="font-size: 11px; color: var(--accent); text-decoration: none; display: block;"
            :title="contactTgUrl"
          >@{{ contact.tgUsername }}</a>
          <div v-else-if="contact.value" class="mono muted ellipsis" style="font-size: 11px;">{{ contact.value }}</div>
        </div>
        <Pill v-if="contact.roleGuess" :state="contact.roleGuess" />
      </div>
      <div v-if="contact.label" style="margin-top: 8px; padding: 6px 8px; background: var(--paper-3); border: 1px solid var(--line); border-radius: 6px; font-size: 11.5px; color: var(--ink-2); line-height: 1.45; white-space: pre-wrap; word-break: break-word;">{{ contact.label }}</div>
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
