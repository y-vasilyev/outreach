<script setup lang="ts">
import { ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import Modal from '../../components/Modal.vue';
import Field from '../../components/Field.vue';
import SelectInput from '../../components/SelectInput.vue';
import TextareaInput from '../../components/TextareaInput.vue';
import Icon from '../../components/Icon.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>();

const text = ref('');
const platformHint = ref<'auto' | 'telegram' | 'instagram' | 'youtube'>('auto');
const fileInput = ref<HTMLInputElement | null>(null);

const mut = useMutation({
  mutationFn: async () => {
    const lines = text.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return api.post<{ accepted: number; skipped: number }>('/channels/import', {
      items: lines,
      platform_hint: platformHint.value === 'auto' ? undefined : platformHint.value,
    });
  },
  onSuccess: (r) => {
    toast.success('Импорт принят', `${r.accepted} новых, ${r.skipped} пропущено`);
    text.value = '';
    emit('done');
  },
  onError: (e: Error) => toast.error('Ошибка импорта', e.message),
});

function pickFile(): void { fileInput.value?.click(); }

function onFile(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  f.text().then((t) => (text.value = t));
}
</script>

<template>
  <Modal
    :open="props.open"
    title="Импорт каналов"
    description="Каждая строка — handle (TG @x, IG instagram.com/y, YT youtube.com/@z) или ссылка."
    size="lg"
    @close="emit('close')"
  >
    <div style="display: grid; gap: 12px; grid-template-columns: 1fr 180px;">
      <Field label="Платформа">
        <SelectInput
          v-model="platformHint as string"
          :options="[
            { value: 'auto', label: 'Авто-определение' },
            { value: 'telegram', label: 'Telegram' },
            { value: 'instagram', label: 'Instagram' },
            { value: 'youtube', label: 'YouTube' },
          ]"
        />
      </Field>
      <Field label="Файл">
        <button class="btn block" type="button" @click="pickFile">
          <Icon name="upload" :size="12" /><span>Загрузить CSV</span>
        </button>
        <input ref="fileInput" type="file" accept=".csv,.txt" class="hidden" @change="onFile" />
      </Field>
    </div>
    <Field label="Список (каждая строка — один канал)" help="Дубликаты по (platform, external_id) объединяются.">
      <TextareaInput
        v-model="text"
        :rows="12"
        mono
        placeholder="@founders_diary&#10;instagram.com/anya_travels&#10;https://youtube.com/@nosquare"
      />
    </Field>
    <template #footer>
      <button class="btn" type="button" :disabled="mut.isPending.value" @click="emit('close')">Отмена</button>
      <button
        class="btn primary"
        type="button"
        :disabled="mut.isPending.value || !text.trim()"
        @click="mut.mutate()"
      >
        <span v-if="mut.isPending.value" class="spinner" />
        <Icon v-else name="upload" :size="12" />
        <span>Импортировать</span>
      </button>
    </template>
  </Modal>
</template>
