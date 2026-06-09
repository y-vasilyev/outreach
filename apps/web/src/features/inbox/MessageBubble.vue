<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../../components/Icon.vue';
import AttachmentImage from './AttachmentImage.vue';
import { formatTime } from '../../lib/format';
import type { ChatMessage, MessageAttachment } from './types';

const props = defineProps<{ msg: ChatMessage }>();
const emit = defineEmits<{ (e: 'reanalyze', messageId: string): void }>();

const isOut = computed(() => props.msg.direction === 'out_');
const isInbound = computed(() => props.msg.direction === 'in_');

// Per-message extraction status (operator-reanalyze-and-markup). Shown on
// inbound messages so the operator sees which replies produced catalog data and
// can re-run the analysis.
const EXTRACTION_LABEL: Record<string, string> = {
  pending: 'анализ…',
  ok: 'извлечено',
  empty: 'пусто',
  no_signal: 'нет сигнала',
  failed: 'ошибка',
};
const EXTRACTION_COLOR: Record<string, string> = {
  pending: 'var(--ink-4)',
  ok: 'var(--ok)',
  empty: 'var(--ink-4)',
  no_signal: 'var(--ink-4)',
  failed: 'var(--bad)',
};
const extractionStatus = computed(() => props.msg.extractionStatus ?? null);
const reanalyzing = computed(() => extractionStatus.value === 'pending');

const OCR_LABEL: Record<string, string> = {
  ok: 'распознано',
  processing: 'распознаётся…',
  failed: 'OCR ошибка',
  unsupported: 'без OCR',
  pending: '',
};
const senderLabel = computed(() => {
  switch (props.msg.sender) {
    case 'ai': return 'AI';
    case 'operator': return 'Operator';
    case 'system': return 'System';
    default: return '';
  }
});

const attachments = computed<MessageAttachment[]>(() => props.msg.attachments ?? []);
const hasAttachments = computed(() => attachments.value.length > 0);
const hasText = computed(() => !!props.msg.text && props.msg.text.length > 0);

function attachmentLabel(a: MessageAttachment): string {
  if (a.fileName) return a.fileName;
  switch (a.kind) {
    case 'image': return 'Image';
    case 'video': return 'Video';
    case 'document': return 'File';
    default: return 'Attachment';
  }
}

function attachmentMeta(a: MessageAttachment): string {
  const parts: string[] = [];
  if (a.mime) parts.push(a.mime);
  if (typeof a.bytes === 'number' && a.bytes > 0) parts.push(formatBytes(a.bytes));
  return parts.join(' · ');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const bubbleStyle = computed(() => ({
  background: isOut.value ? 'var(--ink)' : 'var(--paper-2)',
  color: isOut.value ? 'var(--paper)' : 'var(--ink)',
  border: isOut.value ? '1px solid var(--ink)' : '1px solid var(--line)',
  padding: '9px 12px',
  borderRadius: '10px',
  fontSize: '12.5px',
  lineHeight: '1.55',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
}));

const attachmentBorder = computed(() =>
  isOut.value ? '1px solid var(--paper-3, rgba(255,255,255,0.18))' : '1px solid var(--line)',
);
const attachmentMetaColor = computed(() => (isOut.value ? 'var(--paper-3, rgba(255,255,255,0.65))' : 'var(--ink-4)'));
</script>

<template>
  <!--
    `data-msg-id` is the scroll target used by the inbox data-collection
    HUD (data-collection-hud-target-fields change, Phase 1) — clicking a
    target's source link jumps to the bubble that originated the fact.
  -->
  <div :data-msg-id="msg.id" :style="{ display: 'flex', justifyContent: isOut ? 'flex-end' : 'flex-start', marginBottom: '14px' }">
    <div style="max-width: 520px; min-width: 0;">
      <div :style="bubbleStyle">
        <div
          v-if="hasAttachments"
          :style="{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: hasText ? '8px' : '0' }"
        >
          <template v-for="(a, i) in attachments" :key="i">
            <div v-if="a.kind === 'image' && a.assetId">
              <AttachmentImage :asset-id="a.assetId" :alt="a.fileName" />
              <span
                v-if="a.ocrStatus && OCR_LABEL[a.ocrStatus]"
                :style="{ fontSize: '10px', color: a.ocrStatus === 'failed' ? 'var(--bad)' : 'var(--ink-4)', fontFamily: 'var(--font-mono)' }"
              >{{ OCR_LABEL[a.ocrStatus] }}</span>
            </div>
            <div
              v-else
              :style="{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 8px',
                borderRadius: '6px',
                border: attachmentBorder,
              }"
            >
              <Icon name="paperclip" :size="14" />
              <div :style="{ display: 'flex', flexDirection: 'column', minWidth: 0 }">
                <span :style="{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }">{{ attachmentLabel(a) }}</span>
                <span v-if="attachmentMeta(a)" :style="{ fontSize: '10.5px', color: attachmentMetaColor, fontFamily: 'var(--font-mono)' }">{{ attachmentMeta(a) }}</span>
              </div>
            </div>
          </template>
        </div>
        <span v-if="hasText">{{ msg.text }}</span>
      </div>
      <div
        :style="{
          fontSize: '10.5px',
          color: 'var(--ink-4)',
          fontFamily: 'var(--font-mono)',
          marginTop: '3px',
          display: 'flex',
          gap: '8px',
          justifyContent: isOut ? 'flex-end' : 'flex-start',
          alignItems: 'center',
        }"
      >
        <span v-if="msg.agentName || senderLabel" style="color: var(--accent-2); display: inline-flex; align-items: center; gap: 3px;">
          <Icon name="zap" :size="9" />
          <span>{{ msg.agentName || senderLabel }}</span>
        </span>
        <span>{{ formatTime(msg.sentAt ?? msg.createdAt) }}</span>
        <template v-if="isOut && msg.status">
          <span v-if="msg.status === 'failed'" style="color: var(--bad); display: inline-flex;"><Icon name="warn" :size="10" /></span>
          <span v-else-if="msg.status === 'pending' || msg.status === 'sending'" style="color: var(--ink-4); display: inline-flex;"><Icon name="clock" :size="10" /></span>
          <span v-else style="color: var(--ok); display: inline-flex;"><Icon name="check" :size="10" /></span>
        </template>
        <!-- Per-message extraction status + re-run (operator-reanalyze-and-markup).
             The badge shows only once extraction has a status; the re-run button
             is always available on an inbound (so any reply can be re-analyzed). -->
        <template v-if="isInbound">
          <span
            v-if="extractionStatus"
            :title="msg.extractionError ?? ''"
            :style="{ color: EXTRACTION_COLOR[extractionStatus] ?? 'var(--ink-4)' }"
          >· {{ EXTRACTION_LABEL[extractionStatus] ?? extractionStatus }}</span>
          <button
            type="button"
            :disabled="reanalyzing"
            title="Переанализировать это сообщение"
            :style="{
              background: 'none',
              border: 'none',
              padding: '0',
              cursor: reanalyzing ? 'default' : 'pointer',
              color: 'var(--accent-2)',
              display: 'inline-flex',
              alignItems: 'center',
              opacity: reanalyzing ? 0.5 : 1,
            }"
            @click="emit('reanalyze', msg.id)"
          ><Icon name="refresh" :size="10" /></button>
        </template>
      </div>
    </div>
  </div>
</template>
