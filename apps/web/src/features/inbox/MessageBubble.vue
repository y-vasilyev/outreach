<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../../components/Icon.vue';
import { formatTime } from '../../lib/format';
import type { ChatMessage } from './types';

const props = defineProps<{ msg: ChatMessage }>();

const isOut = computed(() => props.msg.direction === 'out_');
const senderLabel = computed(() => {
  switch (props.msg.sender) {
    case 'ai': return 'AI';
    case 'operator': return 'Operator';
    case 'system': return 'System';
    default: return '';
  }
});

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
</script>

<template>
  <div :style="{ display: 'flex', justifyContent: isOut ? 'flex-end' : 'flex-start', marginBottom: '14px' }">
    <div style="max-width: 520px; min-width: 0;">
      <div :style="bubbleStyle">{{ msg.text }}</div>
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
      </div>
    </div>
  </div>
</template>
