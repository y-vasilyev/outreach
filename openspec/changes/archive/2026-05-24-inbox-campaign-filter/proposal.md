## Why

Сейчас инбокс показывает единый список диалогов поверх всех кампаний — оператор не может сфокусироваться на одной кампании (custdev / agency_sourcing / etc.), оценить её отдельную воронку или сравнить статусы в её рамках. API уже принимает `ConversationFiltersZ` (`campaignId`, `status`, `mode`, `assignedOperatorId`, `q`), но UI его не использует: запрос `GET /conversations` идёт без параметров, а декоративные табы `all/ai/op/meets` помечены `placeholder for future tabs` (см. `apps/web/src/features/inbox/ConversationList.vue:31`).

## What Changes

- Добавить в инбокс панель фильтров: campaign (dropdown по `campaign.name`), status, mode, текстовый поиск `q`. **Дропдаун `assignedOperatorId` пока не добавляем** (см. ниже) — фильтр доступен только через URL/deeplink.
- Серверный `conversationsService.list` начнёт реально применять фильтр `q` (поиск по `contact.value`, `channel.handle`, `channel.title`) — сейчас поле есть в схеме, но игнорируется.
- `ConversationFiltersZ` (`packages/shared/src/schemas/conversation.ts`) дорабатывается: пустые строки в `status`/`mode`/`campaignId`/`assignedOperatorId` нормализуются в `undefined` (иначе `?status=&mode=` падает на enum-парсинге Zod); `q` тримится и капится по длине (≤ 200 символов).
- Состояние фильтров живёт в query string инбокс-маршрута (`/inbox`, `/inbox/:conversationId`); коммит фильтра в URL — через `router.push` (history-entry для back/forward), `router.replace` остаётся только за авто-навигацией (auto-select первого диалога, в которой сейчас и так используется replace).
- React Query queryKey включает фильтры; счётчик в заголовке `Inbox` и табы `ConversationList` пересчитываются от отфильтрованного списка.
- Маршрут `/inbox` поддерживает шорткат `/inbox?campaignId=<id>` — на странице деталей кампании появляется кнопка «Открыть инбокс кампании», которая ведёт сюда.
- Декоративные табы `all/ai/op/meets` в `ConversationList.vue` подключаются к реальной фильтрации (по `pendingSuggestions`, `mode=manual`) поверх серверного фильтра — либо заменяются на видимые применённые фильтры, если они конфликтуют.
- При смене фильтра, если ранее выбранный `:conversationId` оказывается вне отфильтрованного списка, правая панель продолжает показывать его (данные из уже работающего запроса `GET /conversations/:id`), но в списке слева слева он не виден; навигация при клике по элементу списка и при авто-выборе сохраняет текущий `route.query`.
- `api.get` расширяется до `api.get(path, { params })` — сейчас принимает только path; без этого UI-задачи нельзя реализовать без ручного `URLSearchParams` в каждом месте.

Не входит в scope (отдельные изменения, если понадобятся):
- Сохранённые наборы фильтров / pinned views.
- Server-side пагинация (сейчас `take: 100`).
- Bulk-операции над выбранными диалогами.
- UI-дропдаун для `assignedOperatorId`: endpoint `GET /users` сейчас admin-only (`apps/api/src/routes/users.ts:15`), а инбоксом пользуется operator/viewer — добавление role-safe operator-lookup делаем отдельным change.

## Capabilities

### New Capabilities
- `inbox-filters`: контракт списочной выдачи инбокса — какие фильтры обязан поддерживать API, как UI хранит состояние фильтров в URL и какие шорткаты деeplink'ов гарантируются.

### Modified Capabilities
_(нет — `inbox-conversation-resync` и `conversation-quality-gate` касаются открытого диалога, а не списка.)_

## Impact

- **API**: `apps/api/src/services/conversations.ts` (`list`) — добавить реализацию `q`. `apps/api/src/routes/conversations.ts` — без изменений (схема уже принимает фильтры).
- **Shared**: `packages/shared/src/schemas/conversation.ts` — `ConversationFiltersZ` нормализует пустые строки в `undefined` для enum/id-полей и тримит/капит `q` по длине.
- **Web (api lib)**: `apps/web/src/lib/api.ts` — `api.get` расширяется до второго параметра `{ params }` (опционального), который сериализуется в query-string. Существующие вызовы остаются работоспособными.
- **Web**: `apps/web/src/features/inbox/InboxPage.vue`, `ConversationList.vue`, новый компонент `InboxFilters.vue`; роутер `/inbox` читает/пишет query params.
- **Web**: на странице кампании (`apps/web/src/features/campaigns/CampaignDetail*.vue`) — кнопка-ссылка «Открыть инбокс кампании».
- **Tests**: vitest для сервиса (фильтр `q` + комбинации), vitest для UI (state ↔ URL), e2e — short smoke на навигацию `campaign → inbox?campaignId=…`.
- **БД/миграции**: не требуется.
- **Feature flag**: не требуется — изменение не меняет правила безопасности и доступно operator/admin/viewer.
