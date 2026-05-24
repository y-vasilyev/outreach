import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { bootstrapAuth, useAuth } from '../lib/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../features/auth/LoginPage.vue'),
    meta: { public: true, layout: 'blank' },
  },
  {
    path: '/',
    component: () => import('../components/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('../features/dashboard/DashboardPage.vue'),
        meta: { crumbs: ['Дашборд'] },
      },
      {
        path: 'inbox',
        name: 'inbox',
        component: () => import('../features/inbox/InboxPage.vue'),
        meta: { crumbs: ['Чат'], hero: true },
      },
      {
        path: 'inbox/:conversationId',
        name: 'inbox-conversation',
        component: () => import('../features/inbox/InboxPage.vue'),
        meta: { crumbs: ['Чат'], hero: true },
      },
      {
        path: 'channels',
        name: 'channels',
        component: () => import('../features/channels/ChannelsPage.vue'),
        meta: { crumbs: ['Каналы'] },
      },
      {
        path: 'contacts',
        name: 'contacts',
        component: () => import('../features/contacts/ContactsPage.vue'),
        meta: { crumbs: ['Контакты'] },
      },
      {
        path: 'campaigns',
        name: 'campaigns',
        component: () => import('../features/campaigns/CampaignsPage.vue'),
        meta: { crumbs: ['Кампании'] },
      },
      {
        path: 'campaigns/:id',
        name: 'campaign-detail',
        component: () => import('../features/campaigns/CampaignDetailPage.vue'),
        meta: { crumbs: ['Кампании'] },
      },
      {
        path: 'campaign-types/new',
        name: 'campaign-type-builder',
        component: () => import('../features/campaign-types/CampaignTypeBuilderPage.vue'),
        meta: { crumbs: ['Кампании', 'Конструктор типов'] },
      },
      {
        path: 'bloggers',
        name: 'bloggers',
        component: () => import('../features/agency/BloggerCatalogPage.vue'),
        meta: { crumbs: ['Каталог блогеров'] },
      },
      {
        path: 'bloggers/:id',
        name: 'blogger-profile',
        component: () => import('../features/agency/BloggerProfilePage.vue'),
        meta: { crumbs: ['Каталог блогеров'] },
      },
      {
        path: 'match',
        name: 'match',
        component: () => import('../features/agency/MatchPage.vue'),
        meta: { crumbs: ['Подбор блогеров'] },
      },
      {
        path: 'agents',
        name: 'agents',
        component: () => import('../features/agents/AgentsPage.vue'),
        meta: { crumbs: ['Агенты'] },
      },
      {
        path: 'agents/:id',
        name: 'agent-detail',
        component: () => import('../features/agents/AgentDetailPage.vue'),
        meta: { crumbs: ['Агенты'] },
      },
      {
        path: 'tg-accounts',
        name: 'tg-accounts',
        component: () => import('../features/tg-accounts/TgAccountsPage.vue'),
        meta: { crumbs: ['Конфигурация', 'TG-аккаунты'] },
      },
      {
        path: 'endpoints',
        name: 'endpoints',
        component: () => import('../features/endpoints/EndpointsPage.vue'),
        meta: { crumbs: ['Конфигурация', 'Endpoints'] },
      },
      {
        path: 'integrations',
        name: 'integrations',
        component: () => import('../features/integrations/IntegrationsPage.vue'),
        meta: { crumbs: ['Конфигурация', 'Интеграции'] },
      },
      {
        path: 'manual',
        name: 'manual',
        component: () => import('../features/manual/ManualOutreachPage.vue'),
        meta: { crumbs: ['Manual outreach'] },
      },
      {
        path: 'discovery',
        name: 'discovery',
        component: () => import('../features/discovery/DiscoveryPage.vue'),
        // Flag-gated server-side (channel_discovery → 404 when off). The page
        // surfaces a FeatureOff fallback if the flag flips between fetch and
        // navigation; the nav entry is also hidden when the flag is off.
        meta: { crumbs: ['Discovery'] },
      },
      {
        path: 'discovery/batches/:id',
        name: 'discovery-batch',
        component: () => import('../features/discovery/DiscoveryBatchStatusPage.vue'),
        meta: { crumbs: ['Discovery', 'Batch'] },
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('../features/users/UsersPage.vue'),
        meta: { crumbs: ['Команда', 'Пользователи'] },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('../features/audit/AuditPage.vue'),
        meta: { crumbs: ['Команда', 'Аудит'] },
      },
      {
        path: 'settings/features',
        name: 'settings-features',
        component: () => import('../features/settings/FeaturesPage.vue'),
        // Admin-only: runtime feature-flag control plane.
        meta: { crumbs: ['Настройки', 'Фичи'], admin: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  await bootstrapAuth();
  const { user } = useAuth();
  if (!to.meta?.public && !user.value) {
    return { name: 'login', query: to.fullPath !== '/' ? { next: to.fullPath } : undefined };
  }
  if (to.name === 'login' && user.value) return { path: '/' };
  // Admin-only routes (e.g. the feature-flag control plane). Non-admins are
  // bounced to the dashboard; the API also enforces admin on every flag write.
  if (to.meta?.admin && user.value?.role !== 'admin') return { path: '/' };
  return true;
});
