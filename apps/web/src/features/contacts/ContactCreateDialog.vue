<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import SelectInput from '../../components/SelectInput.vue';
import TextInput from '../../components/TextInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import Tag from '../../components/Tag.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Channel } from '../channels/types';
import type { Contact, ContactRole, ContactStatus, ContactType } from './types';

const props = defineProps<{ open: boolean; defaultChannelId?: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();

const qc = useQueryClient();

type Mode = 'single' | 'bulk';
const mode = ref<Mode>('single');

// "Cold lead" — contact without a channel. The backend stores channelId
// as NULL and dedupes via a partial unique index on (type, value).
const isColdLead = ref(false);
const channelId = ref('');

// Single-mode fields
const valueOne = ref('');
const typeOne = ref<ContactType | 'auto'>('auto');
const roleOne = ref<ContactRole>('unknown');
const statusOne = ref<ContactStatus>('new');
const labelOne = ref('');

// Bulk-mode fields
const bulkText = ref('');
const bulkType = ref<ContactType | 'auto'>('auto');
const bulkRole = ref<ContactRole>('unknown');
const bulkStatus = ref<ContactStatus>('new');

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    mode.value = 'single';
    isColdLead.value = false;
    channelId.value = props.defaultChannelId ?? '';
    valueOne.value = '';
    typeOne.value = 'auto';
    roleOne.value = 'unknown';
    statusOne.value = 'new';
    labelOne.value = '';
    bulkText.value = '';
    bulkType.value = 'auto';
    bulkRole.value = 'unknown';
    bulkStatus.value = 'new';
  },
);

// Operator picks the channel from the existing list. We pull a generous
// page (200) and let the browser do client-side filtering via the search
// box; the typical user has well under that. If it ever bites we can
// switch to a server-search combobox.
const { data: channels } = useQuery({
  queryKey: ['channels-for-contact-create'],
  queryFn: () => api.get<Channel[]>('/channels?limit=500'),
  enabled: computed(() => props.open),
  staleTime: 30_000,
});

const channelSearch = ref('');
const channelOptions = computed(() => {
  const list = channels.value ?? [];
  const q = channelSearch.value.trim().toLowerCase();
  const filtered = q
    ? list.filter((c) =>
        `${c.handle} ${c.title ?? ''} ${c.platform}`.toLowerCase().includes(q),
      )
    : list;
  return filtered.slice(0, 100).map((c) => ({
    value: c.id,
    label: `[${c.platform}] ${c.title || c.handle}`,
    platform: c.platform,
    handle: c.handle,
  }));
});

const TYPE_OPTIONS_AUTO = [
  { value: 'auto', label: 'Авто (определить по значению)' },
  { value: 'tg_username', label: 'tg_username' },
  { value: 'tg_link', label: 'tg_link' },
  { value: 'tg_phone', label: 'tg_phone' },
  { value: 'email', label: 'email' },
  { value: 'website', label: 'website' },
  { value: 'web_form', label: 'web_form' },
  { value: 'other', label: 'other' },
];

const ROLE_OPTIONS = [
  { value: 'unknown', label: 'unknown' },
  { value: 'owner', label: 'owner' },
  { value: 'ad_manager', label: 'ad_manager' },
  { value: 'generic', label: 'generic' },
  { value: 'bot', label: 'bot' },
];

const STATUS_OPTIONS = [
  { value: 'new', label: 'new' },
  { value: 'qualified', label: 'qualified' },
  { value: 'disqualified', label: 'disqualified' },
];

const bulkLines = computed(() =>
  bulkText.value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
);

const canSubmitSingle = computed(
  () => (isColdLead.value || !!channelId.value) && !!valueOne.value.trim(),
);
const canSubmitBulk = computed(
  () => (isColdLead.value || !!channelId.value) && bulkLines.value.length > 0,
);

const createMut = useMutation({
  mutationFn: () =>
    api.post<Contact>('/contacts', {
      ...(isColdLead.value ? {} : { channelId: channelId.value }),
      value: valueOne.value.trim(),
      ...(typeOne.value !== 'auto' && { type: typeOne.value }),
      roleGuess: roleOne.value,
      status: statusOne.value,
      ...(labelOne.value.trim() && { label: labelOne.value.trim() }),
    }),
  onSuccess: () => {
    toast.success('Контакт добавлен', 'Помечен как manual override');
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['channels'] });
    emit('done');
  },
  onError: (e: Error) => {
    const ae = e as { code?: string; status?: number; message: string };
    toast.error(
      'Не удалось добавить',
      `${ae.code ?? ''}${ae.status ? ` ${ae.status}` : ''} ${ae.message}`.trim(),
    );
  },
});

const bulkMut = useMutation({
  mutationFn: () =>
    api.post<{
      accepted: number;
      skipped: number;
      created: { id: string }[];
      errors: { input: string; reason: string }[];
    }>('/contacts/bulk', {
      ...(isColdLead.value ? {} : { channelId: channelId.value }),
      items: bulkLines.value,
      defaults: {
        ...(bulkType.value !== 'auto' && { type: bulkType.value }),
        roleGuess: bulkRole.value,
        status: bulkStatus.value,
      },
    }),
  onSuccess: (r) => {
    toast.success(
      'Контакты добавлены',
      r.skipped > 0
        ? `${r.accepted} новых, ${r.skipped} пропущено (дубли / невалидные)`
        : `${r.accepted} новых`,
    );
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['channels'] });
    emit('done');
  },
  onError: (e: Error) => {
    const ae = e as { code?: string; status?: number; message: string };
    toast.error(
      'Не удалось добавить',
      `${ae.code ?? ''}${ae.status ? ` ${ae.status}` : ''} ${ae.message}`.trim(),
    );
  },
});

const submitting = computed(() => createMut.isPending.value || bulkMut.isPending.value);

function submit(): void {
  if (mode.value === 'single') createMut.mutate();
  else bulkMut.mutate();
}
</script>

<template>
  <Modal
    :open="props.open"
    title="Добавить контакт"
    description="Контакт привязан к каналу. Помечается как manual override — LLM-extractor не перетрёт."
    size="lg"
    @close="emit('close')"
  >
    <div style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; gap: 6px; padding: 3px; background: var(--paper-3); border: 1px solid var(--line); border-radius: var(--r-sm); width: fit-content;">
        <button
          type="button"
          class="btn ghost sm"
          :class="mode === 'single' ? 'primary' : ''"
          :style="mode === 'single' ? 'background: var(--paper); box-shadow: 0 1px 2px rgba(0,0,0,.06);' : ''"
          @click="mode = 'single'"
        >
          <Icon name="user" :size="11" /><span>Один контакт</span>
        </button>
        <button
          type="button"
          class="btn ghost sm"
          :class="mode === 'bulk' ? 'primary' : ''"
          :style="mode === 'bulk' ? 'background: var(--paper); box-shadow: 0 1px 2px rgba(0,0,0,.06);' : ''"
          @click="mode = 'bulk'"
        >
          <Icon name="upload" :size="11" /><span>Пачкой</span>
        </button>
      </div>

      <div style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--paper-3); border: 1px solid var(--line); border-radius: var(--r-sm);">
        <input
          id="cold-lead-toggle"
          v-model="isColdLead"
          type="checkbox"
          style="margin: 0;"
        />
        <label for="cold-lead-toggle" style="cursor: pointer; flex: 1; font-size: 12.5px;">
          <strong>Холодный лид</strong> — контакт без канала
          <div class="muted-2" style="font-size: 10.5px; margin-top: 2px;">
            Полезно когда email / @handle получили со стороны и связывать с парсингом
            канала не нужно.
          </div>
        </label>
      </div>

      <Field
        v-if="!isColdLead"
        label="Канал"
        help="Контакт будет привязан к этому каналу."
      >
        <TextInput
          v-model="channelSearch"
          placeholder="Поиск по handle / title…"
          :mono="false"
        />
        <SelectInput
          v-model="channelId"
          :options="[{ value: '', label: '— выберите канал —' }, ...channelOptions]"
          style="margin-top: 6px;"
        />
        <div v-if="channelId && channelOptions.find((o) => o.value === channelId)" class="muted-2" style="margin-top: 4px; font-size: 11px;">
          <Tag :platform="channelOptions.find((o) => o.value === channelId)!.platform" />
          <span style="margin-left: 4px;">@{{ channelOptions.find((o) => o.value === channelId)!.handle }}</span>
        </div>
      </Field>

      <template v-if="mode === 'single'">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <Field label="Тип">
            <SelectInput v-model="typeOne as string" :options="TYPE_OPTIONS_AUTO" />
          </Field>
          <Field label="Роль">
            <SelectInput v-model="roleOne as string" :options="ROLE_OPTIONS" />
          </Field>
          <Field
            label="Value"
            style="grid-column: 1 / -1;"
            help="@username, t.me/…, email, +7…, https://…"
          >
            <TextInput v-model="valueOne" :mono="true" placeholder="@founders_diary" />
          </Field>
          <Field label="Статус">
            <SelectInput v-model="statusOne as string" :options="STATUS_OPTIONS" />
          </Field>
          <Field label="Заметка / label" help="Опционально">
            <TextInput v-model="labelOne" placeholder="Жена основателя" />
          </Field>
        </div>
      </template>

      <template v-else>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px;">
          <Field label="Тип (на все строки)">
            <SelectInput v-model="bulkType as string" :options="TYPE_OPTIONS_AUTO" />
          </Field>
          <Field label="Роль (на все)">
            <SelectInput v-model="bulkRole as string" :options="ROLE_OPTIONS" />
          </Field>
          <Field label="Статус (на все)">
            <SelectInput v-model="bulkStatus as string" :options="STATUS_OPTIONS" />
          </Field>
        </div>
        <Field
          label="Контакты"
          :help="`Каждая строка — один контакт. ${bulkLines.length ? `Распознано: ${bulkLines.length}.` : ''} Дубли по (тип, value) на канале пропускаются.`"
        >
          <TextareaInput
            v-model="bulkText"
            :rows="10"
            mono
            placeholder="@founders_diary&#10;ads@founders.com&#10;t.me/+abc123&#10;https://founders.com/contact"
          />
        </Field>
      </template>
    </div>

    <template #footer>
      <button class="btn" type="button" :disabled="submitting" @click="emit('close')">Отмена</button>
      <button
        class="btn primary"
        type="button"
        :disabled="
          submitting ||
          (mode === 'single' ? !canSubmitSingle : !canSubmitBulk)
        "
        @click="submit"
      >
        <span v-if="submitting" class="spinner" />
        <Icon v-else name="plus" :size="12" />
        <span v-if="mode === 'single'">Добавить</span>
        <span v-else>Добавить ({{ bulkLines.length }})</span>
      </button>
    </template>
  </Modal>
</template>
