import { ref } from 'vue';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
}

const items = ref<ToastItem[]>([]);
let nextId = 0;

function show(t: Omit<ToastItem, 'id'>): void {
  const id = ++nextId;
  items.value = [...items.value, { ...t, id }];
  window.setTimeout(() => remove(id), 4500);
}

function remove(id: number): void {
  items.value = items.value.filter((t) => t.id !== id);
}

export const toast = {
  show,
  success: (title: string, description?: string) => show({ variant: 'success', title, description }),
  error: (title: string, description?: string) => show({ variant: 'error', title, description }),
  info: (title: string, description?: string) => show({ variant: 'info', title, description }),
  warning: (title: string, description?: string) => show({ variant: 'warning', title, description }),
  remove,
};

export function useToastStore(): { items: typeof items; remove: typeof remove } {
  return { items, remove };
}
