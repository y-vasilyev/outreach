<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import SelectInput from '../../components/SelectInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import Pill from '../../components/Pill.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { truncate } from '../../lib/format';
import type { Contact } from './types';
import type { TgAccount } from '../tg-accounts/types';
import type { Campaign } from '../campaigns/types';

const props = defineProps<{ contact: Contact | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'started', conversationId: string): void }>();

const router = useRouter();

const isOpen = computed(() => !!props.contact);

const tgAccountId = ref('');
const campaignId = ref('');
const mode = ref<'auto' | 'semi_auto' | 'assisted' | 'manual'>('assisted');
const goalText = ref('');
const valueProp = ref('');
const scheduledLocal = ref('');

const { data: tgAccounts } = useQuery({
  queryKey: ['tg-accounts'],
  queryFn: () => api.get<TgAccount[]>('/tg-accounts'),
  enabled: isOpen,
  staleTime: 60_000,
});

const { data: campaigns } = useQuery({
  queryKey: ['campaigns'],
  queryFn: () => api.get<Campaign[]>('/campaigns'),
  enabled: isOpen,
  staleTime: 60_000,
});

const outreachAccounts = computed(() =>
  (tgAccounts.value ?? []).filter(
    (a) => (a.role === 'outreach' || a.role === 'both') && a.status === 'active',
  ),
);

const tgAccountOptions = computed(() =>
  outreachAccounts.value.length === 0
    ? [{ value: '', label: '— нет активных outreach-аккаунтов —' }]
    : outreachAccounts.value.map((a) => ({
        value: a.id,
        label: `${a.label} · ${a.phone}`,
      })),
);

const campaignOptions = computed(() => [
  { value: '', label: '— ad-hoc (без кампании) —' },
  ...((campaigns.value ?? []).map((c) => ({ value: c.id, label: c.name }))),
]);

// When a campaign is picked, prefill goal/value/mode/account so the operator
// only has to confirm. They can still override before submitting.
watch(
  campaignId,
  (id) => {
    if (!id) return;
    const c = (campaigns.value ?? []).find((x) => x.id === id);
    if (!c) return;
    goalText.value = c.goalText;
    valueProp.value = c.valueProp;
    mode.value = c.defaultMode;
    if (!tgAccountId.value && c.outreachAccountPool && c.outreachAccountPool.length > 0) {
      const first = c.outreachAccountPool.find((accId) =>
        outreachAccounts.value.some((a) => a.id === accId),
      );
      if (first) tgAccountId.value = first;
    }
  },
);

watch(
  () => props.contact,
  (c) => {
    if (!c) return;
    // Reset on each open. Default to first active outreach account so the
    // common "1 account" case is one-click.
    campaignId.value = '';
    mode.value = 'assisted';
    goalText.value = '';
    valueProp.value = '';
    scheduledLocal.value = '';
    if (outreachAccounts.value.length > 0) {
      tgAccountId.value = outreachAccounts.value[0]!.id;
    } else {
      tgAccountId.value = '';
    }
  },
);

const canSubmit = computed(() => {
  if (!tgAccountId.value) return false;
  // Need *some* steering: either link to a campaign or supply goal+value.
  if (campaignId.value) return true;
  return goalText.value.trim().length > 0 && valueProp.value.trim().length > 0;
});

const contextLines = computed(() => {
  const c = props.contact;
  if (!c) return [];
  const out: Array<{ label: string; text: string }> = [];
  if (c.label) out.push({ label: 'Контекст контакта', text: c.label });
  if (c.rawValue && c.rawValue !== c.value) out.push({ label: 'Как найден', text: c.rawValue });
  if (c.channel?.description) out.push({ label: 'Описание канала', text: truncate(c.channel.description, 600) });
  return out;
});

function scheduledIso(): string | undefined {
  if (!scheduledLocal.value) return undefined;
  const d = new Date(scheduledLocal.value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const startMut = useMutation({
  mutationFn: () =>
    api.post<{ ok: true; conversationId: string; created: boolean }>(
      `/contacts/${props.contact!.id}/start-conversation`,
      {
        tgAccountId: tgAccountId.value,
        ...(campaignId.value ? { campaignId: campaignId.value } : {}),
        ...(goalText.value ? { goalText: goalText.value } : {}),
        ...(valueProp.value ? { valueProp: valueProp.value } : {}),
        ...(scheduledIso() ? { scheduledAt: scheduledIso() } : {}),
        mode: mode.value,
      },
    ),
  onSuccess: (r) => {
    toast.success(
      r.created ? 'Диалог создан' : 'Диалог обновлён',
      'AI-assistant генерирует первое сообщение — откроется Inbox.',
    );
    emit('started', r.conversationId);
    router.push(`/inbox/${r.conversationId}`);
  },
  onError: (e: Error) => toast.error('Не удалось создать диалог', e.message),
});
</script>

<template>
  <Modal
    :open="isOpen"
    :title="contact ? `Начать чат: ${contact.value}` : ''"
    description="Создаём диалог и просим OpeningComposer написать первое сообщение. Через несколько секунд оно появится в Inbox как pending suggestion."
    size="lg"
    @close="emit('close')"
  >
    <div v-if="contact" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="card">
        <div class="card-head"><Icon name="user" :size="12" /><span>Контакт</span></div>
        <div class="card-body">
          <dl class="kv">
            <dt>Канал</dt>
            <dd>{{ contact.channel?.title || contact.channel?.handle || '—' }}</dd>
            <dt>Контакт</dt>
            <dd class="mono">{{ contact.value }}</dd>
            <dt>Роль</dt>
            <dd><Pill :state="contact.roleGuess" /></dd>
            <dt>Reachability</dt>
            <dd><Pill :state="contact.reachability" /></dd>
          </dl>
          <div v-if="contextLines.length" style="margin-top: 10px; display: grid; gap: 8px;">
            <div
              v-for="line in contextLines"
              :key="line.label"
              style="border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--paper-2); padding: 8px 10px;"
            >
              <div class="muted-2" style="font-size: 10.5px; margin-bottom: 4px;">{{ line.label }}</div>
              <div style="font-size: 12px; line-height: 1.45; white-space: pre-wrap; color: var(--ink-2);">{{ line.text }}</div>
            </div>
          </div>
          <div
            v-if="contact.reachability !== 'reachable_tg'"
            class="muted"
            style="margin-top: 8px; padding: 8px 10px; background: var(--warn-bg); color: var(--warn); border: 1px solid var(--warn-line); border-radius: var(--r-sm); font-size: 11.5px;"
          >
            Этот контакт не reachable_tg — отправка через Telegram невозможна. Используйте
            Manual outreach.
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><Icon name="send" :size="12" /><span>С какого аккаунта</span></div>
        <div class="card-body">
          <Field label="Outreach-аккаунт">
            <SelectInput v-model="tgAccountId" :options="tgAccountOptions" />
          </Field>
          <div
            v-if="outreachAccounts.length === 0"
            class="muted"
            style="margin-top: 8px; padding: 8px 10px; background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad-line); border-radius: var(--r-sm); font-size: 11.5px;"
          >
            Нет активных outreach-аккаунтов. Подключите хотя бы один на странице
            «TG-аккаунты».
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <Icon name="flag" :size="12" /><span>Цель и value-prop</span>
          <span class="muted-2" style="margin-left: 6px; font-size: 11px;">
            привязать к кампании (рекомендуется) или задать ad-hoc
          </span>
        </div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <Field label="Кампания">
              <SelectInput v-model="campaignId" :options="campaignOptions" />
            </Field>
            <Field label="Режим">
              <SelectInput
                v-model="mode as string"
                :options="[
                  { value: 'auto', label: 'auto — auto-send top-suggestion' },
                  { value: 'assisted', label: 'assisted — оператор подтверждает' },
                  { value: 'manual', label: 'manual — оператор пишет сам' },
                ]"
              />
            </Field>
            <Field label="Цель CustDev" style="grid-column: 1 / -1;" :help="campaignId ? 'Подтянуто из кампании. Можно поправить.' : 'Без кампании goal/value-prop обязательны.'">
              <TextareaInput v-model="goalText" :rows="2" placeholder="20 минут CustDev по продукту X" />
            </Field>
            <Field label="Value-prop" style="grid-column: 1 / -1;">
              <TextareaInput v-model="valueProp" :rows="2" placeholder="доступ к бете / $30 / отчёт" />
            </Field>
            <Field
              label="Старт отправки"
              style="grid-column: 1 / -1;"
              help="Подсказка сгенерируется сразу. Для auto-режима отправка уйдёт не раньше этого времени плюс небольшой jitter."
            >
              <input class="input" type="datetime-local" v-model="scheduledLocal" />
            </Field>
          </div>
          <div class="muted-2" style="margin-top: 8px; font-size: 11px;">
            Краткий путь: на кампании уже задан goal/value-prop — выберите её,
            подтвердите и нажмите «Создать чат».
          </div>
        </div>
      </div>

      <div v-if="contact.status === 'new'" class="placeholder" style="font-family: var(--font-ui); font-size: 11.5px; min-height: 0; padding: 8px 12px; color: var(--ink-3);">
        <strong style="color: var(--warn);">Подсказка:</strong>
        этот контакт со статусом <span class="mono">new</span>. Кампания-диспетчер берёт
        только <span class="mono">qualified</span>, но эта кнопка работает в обход —
        диалог создастся всё равно, и контакт после OpeningComposer перейдёт в
        <span class="mono">contacted</span>.
      </div>
    </div>

    <template #footer>
      <button class="btn" :disabled="startMut.isPending.value" @click="emit('close')">Отмена</button>
      <button
        class="btn primary"
        :disabled="!canSubmit || startMut.isPending.value || (contact?.reachability !== 'reachable_tg')"
        @click="startMut.mutate()"
      >
        <span v-if="startMut.isPending.value" class="spinner" />
        <Icon v-else name="zap" :size="11" />
        <span>Создать чат и сгенерировать opening</span>
      </button>
    </template>
  </Modal>
</template>
