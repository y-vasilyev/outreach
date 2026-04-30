<script setup lang="ts" generic="T">
import Spinner from './Spinner.vue';
import EmptyState from './EmptyState.vue';

defineProps<{
  rows: T[] | undefined;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  rowKey: (row: T) => string;
  selectedKey?: string | null;
  onRowClick?: ((row: T) => void) | null;
}>();
</script>

<template>
  <div v-if="loading" class="center">
    <Spinner /><span style="margin-left: 8px;">Загрузка…</span>
  </div>
  <EmptyState
    v-else-if="!rows || rows.length === 0"
    :title="emptyTitle ?? 'Пока пусто'"
    :description="emptyDescription"
    icon="inbox"
  >
    <template v-if="$slots['empty-action']" #action>
      <slot name="empty-action" />
    </template>
  </EmptyState>
  <div v-else class="table-wrap">
    <table class="tbl">
      <thead>
        <slot name="head" />
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="rowKey(row)"
          :class="[
            onRowClick ? 'clickable' : '',
            selectedKey != null && rowKey(row) === selectedKey ? 'selected' : '',
          ]"
          @click="onRowClick && onRowClick(row)"
        >
          <slot name="row" :row="row" />
        </tr>
      </tbody>
    </table>
  </div>
</template>
