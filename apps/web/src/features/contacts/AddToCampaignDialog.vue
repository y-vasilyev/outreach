<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Pill from '../../components/Pill.vue';
import Spinner from '../../components/Spinner.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { truncate } from '../../lib/format';
import type { Campaign } from '../campaigns/types';

const props = defineProps<{ open: boolean; contactIds: string[] }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();

const selectedId = ref<string | null>(null);

watch(
  () => props.open,
  (v) => {
    if (v) selectedId.value = null;
  },
);

const { data: campaigns, isLoading } = useQuery({
  queryKey: ['campaigns'],
  queryFn: () => api.get<Campaign[]>('/campaigns'),
  enabled: computed(() => props.open),
});

const list = computed<Campaign[]>(() => campaigns.value ?? []);

type AddContactsResponse = {
  added: number;
  requested: number;
  chatsCreated: number;
  blocker:
    | 'campaign_not_running'
    | 'no_accounts'
    | 'outside_schedule'
    | 'no_active_accounts'
    | null;
};

const BLOCKER_HINT: Record<NonNullable<AddContactsResponse['blocker']>, string> = {
  campaign_not_running: 'Кампания не в статусе running — запустите её, чтобы начались отправки.',
  no_accounts: 'В кампании нет TG-аккаунтов — добавьте в настройках кампании.',
  outside_schedule: 'Сейчас вне расписания кампании. Чаты создадутся в окно работы.',
  no_active_accounts: 'Все TG-аккаунты в cooldown / need_auth. Проверьте на странице аккаунтов.',
};

const mut = useMutation({
  mutationFn: () =>
    api.post<AddContactsResponse>(
      `/campaigns/${selectedId.value}/contacts`,
      { contactIds: props.contactIds },
    ),
  onSuccess: (r) => {
    const skipped = r.requested - r.added;
    if (r.blocker) {
      // Tagging worked but dispatch is blocked — operator needs to fix.
      toast.warning(
        `Контакты добавлены: ${r.added}${skipped > 0 ? ` (${skipped} уже были)` : ''}`,
        BLOCKER_HINT[r.blocker],
      );
    } else if (r.chatsCreated > 0) {
      toast.success(
        `Создано чатов: ${r.chatsCreated}`,
        'Опенинги генерируются — увидите их в /inbox через несколько секунд.',
      );
    } else {
      // Tagged but no new chats — usually means everyone already had a
      // chat in this campaign (re-add).
      toast.info(
        'Контакты уже в кампании',
        skipped > 0
          ? `${r.added} новых тегов, ${skipped} уже были; чатов не создано (уже есть)`
          : 'Чатов не создано (контакты уже в кампании или не TG-достижимы).',
      );
    }
    emit('done');
  },
  onError: (e: Error) => toast.error('Не удалось добавить', e.message),
});
</script>

<template>
  <Modal
    :open="props.open"
    :title="`В кампанию (${contactIds.length})`"
    description="Выбранные контакты будут протегированы и попадут в фильтр кампании. Можно отменить, убрав тег."
    size="md"
    @close="emit('close')"
  >
    <div v-if="isLoading" class="center"><Spinner /></div>
    <div v-else-if="list.length === 0" class="placeholder" style="min-height: 80px;">
      Сначала создайте кампанию на странице «Кампании».
    </div>
    <div v-else style="display: flex; flex-direction: column; gap: 6px;">
      <button
        v-for="c in list"
        :key="c.id"
        type="button"
        :style="{
          display: 'flex',
          gap: '10px',
          padding: '10px 12px',
          border: `1px solid ${selectedId === c.id ? 'var(--accent)' : 'var(--line)'}`,
          background: selectedId === c.id ? 'var(--accent-bg)' : 'var(--paper)',
          borderRadius: 'var(--r-md)',
          textAlign: 'left',
          cursor: 'pointer',
          width: '100%',
        }"
        @click="selectedId = c.id"
      >
        <span
          :style="{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            border: `1.5px solid ${selectedId === c.id ? 'var(--accent)' : 'var(--line-2)'}`,
            background: selectedId === c.id ? 'var(--accent)' : 'transparent',
            flexShrink: 0,
            marginTop: '3px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
          }"
        >
          <Icon v-if="selectedId === c.id" name="check" :size="9" :stroke="3" />
        </span>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="cell-strong ellipsis" style="flex: 1;">{{ c.name }}</span>
            <Pill :state="c.status" />
          </div>
          <div class="muted" style="font-size: 11.5px; margin-top: 4px;">{{ truncate(c.goalText, 140) }}</div>
        </div>
      </button>
    </div>

    <template #footer>
      <button class="btn" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button
        class="btn primary"
        :disabled="mut.isPending.value || !selectedId || contactIds.length === 0"
        @click="mut.mutate()"
      >
        <span v-if="mut.isPending.value" class="spinner" />
        <Icon v-else name="zap" :size="11" />
        <span>Добавить {{ contactIds.length }}</span>
      </button>
    </template>
  </Modal>
</template>
