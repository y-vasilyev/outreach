<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import PageHead from '../../components/PageHead.vue';
import Pill from '../../components/Pill.vue';
import Avatar from '../../components/Avatar.vue';
import Icon from '../../components/Icon.vue';
import Spinner from '../../components/Spinner.vue';
import EmptyState from '../../components/EmptyState.vue';
import ConfirmDialog from '../../components/ConfirmDialog.vue';
import UserForm from './UserForm.vue';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { initials, formatDateTime } from '../../lib/format';
import { avatarColor } from '../../lib/state';
import type { UserRow } from './types';

const qc = useQueryClient();

const formOpen = ref(false);
const editing = ref<UserRow | null>(null);
const deleteFor = ref<UserRow | null>(null);

const { data, isLoading } = useQuery({
  queryKey: ['users'],
  queryFn: () => api.get<UserRow[]>('/users'),
});

const list = computed<UserRow[]>(() => data.value ?? []);

const delMut = useMutation({
  mutationFn: (id: string) => api.del<void>(`/users/${id}`),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    toast.success('Пользователь удалён');
    deleteFor.value = null;
  },
});

function openEdit(u: UserRow): void { editing.value = u; formOpen.value = true; }
function openNew(): void { editing.value = null; formOpen.value = true; }
</script>

<template>
  <PageHead title="Пользователи" sub="Операторы и роли. Admin может всё, operator ведёт диалоги, viewer только смотрит.">
    <template #actions>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Добавить пользователя</span></button>
    </template>
  </PageHead>

  <div v-if="isLoading" class="center"><Spinner /></div>
  <EmptyState
    v-else-if="list.length === 0"
    title="Пользователей нет"
    description="Создайте операторов, чтобы передавать им подсказки и эскалации."
    icon="users"
  >
    <template #action>
      <button class="btn primary" @click="openNew"><Icon name="plus" :size="12" /><span>Добавить</span></button>
    </template>
  </EmptyState>
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>Пользователь</th>
          <th>Роль</th>
          <th>Создан</th>
          <th style="width: 100px;"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in list" :key="u.id">
          <td>
            <div style="display: flex; align-items: center; gap: 9px;">
              <Avatar :text="initials(u.email)" :color="avatarColor(u.id)" round />
              <div class="cell-strong ellipsis">{{ u.email }}</div>
            </div>
          </td>
          <td><Pill :state="u.role" /></td>
          <td class="muted-2 mono" style="font-size: 10.5px;">{{ formatDateTime(u.createdAt) }}</td>
          <td>
            <div style="display: flex; gap: 4px; justify-content: flex-end;">
              <button class="btn ghost icon-only sm" @click="openEdit(u)"><Icon name="edit" :size="12" /></button>
              <button class="btn ghost icon-only sm" @click="deleteFor = u" style="color: var(--bad);"><Icon name="trash" :size="12" /></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <UserForm
    :open="formOpen"
    :user="editing"
    @close="formOpen = false"
    @saved="() => { formOpen = false; qc.invalidateQueries({ queryKey: ['users'] }); }"
  />
  <ConfirmDialog
    :open="!!deleteFor"
    title="Удалить пользователя?"
    :description="deleteFor ? `Учётка «${deleteFor.email}» будет удалена. Связанные действия в audit_log сохраняются.` : ''"
    confirm-label="Удалить"
    destructive
    :loading="delMut.isPending.value"
    @close="deleteFor = null"
    @confirm="deleteFor && delMut.mutate(deleteFor.id)"
  />
</template>
