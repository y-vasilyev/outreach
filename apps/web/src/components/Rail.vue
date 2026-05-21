<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { computed, ref, onBeforeUnmount, onMounted } from 'vue';
import Icon from './Icon.vue';
import type { IconName } from '../lib/icons';
import { useAuth } from '../lib/auth';
import { useFlags } from '../lib/config';
import { initials } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  badge?: number | string | null;
}

const props = defineProps<{
  counts?: Record<string, number | undefined>;
}>();

const route = useRoute();
const router = useRouter();
const { user, logout } = useAuth();
const flags = useFlags();

const groups = computed<{ group: string; items: NavItem[] }[]>(() => [
  {
    group: 'Работа',
    items: [
      { to: '/inbox', label: 'Чат', icon: 'chat', badge: props.counts?.inbox ?? null },
      { to: '/campaigns', label: 'Кампании', icon: 'zap', badge: props.counts?.campaigns ?? null },
      { to: '/channels', label: 'Каналы', icon: 'layers', badge: props.counts?.channels ?? null },
      { to: '/contacts', label: 'Контакты', icon: 'users_round', badge: props.counts?.contacts ?? null },
      // Agency surfaces only render when their flag is on, so a legacy operator
      // sees the unchanged nav.
      ...(flags.value.agencySourcing
        ? [{ to: '/bloggers', label: 'Каталог', icon: 'globe' as const, badge: null }]
        : []),
      ...(flags.value.bloggerMatching
        ? [{ to: '/match', label: 'Подбор', icon: 'search' as const, badge: null }]
        : []),
      { to: '/manual', label: 'Manual', icon: 'mail', badge: props.counts?.manual ?? null },
    ],
  },
  {
    group: 'Конфигурация',
    items: [
      { to: '/agents', label: 'Агенты', icon: 'bot' },
      { to: '/tg-accounts', label: 'TG-аккаунты', icon: 'send' },
      { to: '/endpoints', label: 'Endpoints', icon: 'database' },
      { to: '/integrations', label: 'Интеграции', icon: 'link' },
    ],
  },
  {
    group: 'Команда',
    items: [
      { to: '/users', label: 'Пользователи', icon: 'users' },
      { to: '/audit', label: 'Аудит', icon: 'shield' },
    ],
  },
  {
    group: 'Обзор',
    items: [{ to: '/', label: 'Дашборд', icon: 'trend' }],
  },
]);

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/';
  return route.path === to || route.path.startsWith(to + '/');
}

function go(to: string): void {
  router.push(to);
}

const userMenuOpen = ref(false);
function toggleMenu(): void { userMenuOpen.value = !userMenuOpen.value; }

function handleClickOutside(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  if (!t.closest?.('.rail-foot')) userMenuOpen.value = false;
}
onMounted(() => document.addEventListener('mousedown', handleClickOutside));
onBeforeUnmount(() => document.removeEventListener('mousedown', handleClickOutside));

const userInitials = computed(() => initials(user.value?.name || user.value?.email, '??'));
</script>

<template>
  <aside class="rail">
    <div class="rail-brand">
      <span class="logo" />
      <span class="name">Nosquare</span>
      <span class="env">prod</span>
    </div>
    <div v-for="(g, gi) in groups" :key="gi" class="rail-section">
      <div class="rail-section-title">{{ g.group }}</div>
      <div
        v-for="it in g.items"
        :key="it.to"
        :class="['rail-item', isActive(it.to) ? 'active' : '']"
        @click="go(it.to)"
      >
        <span class="icon"><Icon :name="it.icon" :size="14" /></span>
        <span>{{ it.label }}</span>
        <span v-if="it.badge != null" class="badge">{{ it.badge }}</span>
      </div>
    </div>
    <div class="rail-foot" @click="toggleMenu">
      <div class="ava">{{ userInitials }}</div>
      <div class="grow">
        <div class="who ellipsis">{{ user?.name || user?.email || 'Гость' }}</div>
        <div class="who-sub ellipsis">{{ user?.role || '—' }}</div>
      </div>
      <span class="who-link"><Icon name="chev_up_down" :size="12" /></span>

      <div v-if="userMenuOpen" class="dropdown-menu" style="position: absolute; bottom: 56px; left: 12px; right: 12px;">
        <button class="dropdown-item" @click.stop="router.push('/users'); userMenuOpen = false">
          <Icon name="user" :size="13" /> Профиль
        </button>
        <button class="dropdown-item" @click.stop="router.push('/integrations'); userMenuOpen = false">
          <Icon name="settings" :size="13" /> Настройки
        </button>
        <div class="dropdown-divider" />
        <button class="dropdown-item danger" @click.stop="logout">
          <Icon name="log_out" :size="13" /> Выйти
        </button>
      </div>
    </div>
  </aside>
</template>
