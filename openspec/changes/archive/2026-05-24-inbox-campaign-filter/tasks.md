## 1. Shared: нормализация `ConversationFiltersZ` на границе

- [x] 1.1 В `packages/shared/src/schemas/conversation.ts` доработать `ConversationFiltersZ`: для `status` и `mode` пустую строку `""` препроцессить в `undefined` (иначе Zod enum `optional()` бросает ZodError на `?status=`); для `campaignId` и `assignedOperatorId` — preprocess: trim, пустую строку → `undefined`; для `q` — preprocess: trim, пустую → `undefined`, плюс `.max(200)` (overlong отвергаем). См. Decision 2 в design.md.
- [x] 1.2 vitest unit для `ConversationFiltersZ` в `packages/shared/tests/` (или ближайшем существующем тест-файле схем): `?status=&mode=` парсится в `{}` без ошибки; `q="   "` → `q: undefined`; `q` длиной 201 → ZodError; whitespace в `campaignId` → `undefined`.

## 2. API: реализация фильтра `q` и проверка комбинаций

- [x] 2.1 В `apps/api/src/services/conversations.ts` (`conversationsService.list`) добавить ветку `q` — `OR` по `contact.value` / `contact.channel.handle` / `contact.channel.title` с `mode: 'insensitive'`. Соблюсти существующий стиль conditional spread. Сервис полагается на гарантии схемы (trim/cap уже сделаны), дополнительной нормализации не делает.
- [x] 2.2 vitest (`apps/api/src/services/__tests__/conversations-list-filters.test.ts`): 8 сценариев — пустые фильтры → `{}` where, campaignId, status+mode, assignedOperatorId, q (OR insensitive contains), campaignId+q конъюнкция, unknown campaignId (без ошибки), undefined-значения не утекают в where. `q` длиной 201 → 400 покрыт schema-level тестом + общим `setErrorHandler(ZodError)` маппингом в `apps/api/src/error-handler.ts`.

## 3. Web (api lib): расширить `api.get` для query-параметров

- [x] 3.1 В `apps/web/src/lib/api.ts` расширить `api.get` до сигнатуры `<T>(path, options?: { params?: Record<string, string | undefined> })`. Реализовать локальную утилиту `appendQuery(path, params)`: пропускать `undefined/null/""`; остальное `URLSearchParams.toString()`; корректно мерджить с существующим query string в `path`. Существующие вызовы `api.get('/foo')` остаются работоспособными.
- [x] 3.2 vitest unit для `appendQuery`: пустой params → path без `?`; key с `undefined` отбрасывается; уже существующий query string в path сохраняется; спецсимволы URL-кодируются.

## 4. Web: state в URL и React Query queryKey

- [x] 4.1 В `apps/web/src/features/inbox/InboxPage.vue` завести `computed` `filters` от `route.query` (whitelist полей: `campaignId`, `status`, `mode`, `assignedOperatorId`, `q`; всё остальное игнорировать). Прокидывать в `useQuery({ queryKey: ['conversations', filters], queryFn: () => api.get('/conversations', { params: filters }) })`. Существующий `refetchInterval: 30_000` оставить. Helper в `apps/web/src/features/inbox/filters.ts` — `parseInboxFilters` с whitelist + enum-валидацией.
- [x] 4.2 Хелпер `updateFilters(patch)` — `router.push({ name: route.name, params: route.params, query: nextQuery })` с удалением ключа при `undefined/''`. Используется для пользовательских действий из `InboxFilters.vue`. Реализован в `InboxPage.vue` через `mergeFilterQuery`.
- [x] 4.3 Auto-select первого диалога: если `:conversationId` отсутствует и `list[0]` есть, навигировать `router.replace({ name: route.name, params: { conversationId: list[0].id }, query: route.query })`. Auto-select остаётся через `replace`, чтобы не засорять history (Decision 1).
- [x] 4.4 Не вытеснять выбранный `conversationId`, если он не входит в новый отфильтрованный список (Decision 4). Источник правой панели: `current = list.find(...) ?? details ?? null` — `details` приходит из уже существующего `useQuery(['conversation', conversationId])` (`InboxPage.vue:38`). Если `details` ещё не загрузился, правая панель показывает loading-state, а не «выберите диалог».
- [x] 4.5 Поправить `pick(id)` (`InboxPage.vue:50`): `router.push({ name: 'inbox-conversation', params: { conversationId: id }, query: route.query })` — текущая реализация `router.push('/inbox/' + id)` теряет query.

## 5. Web: компонент `InboxFilters.vue`

- [x] 5.1 Создать `apps/web/src/features/inbox/InboxFilters.vue` — props: `modelValue: Filters`; emits `update:modelValue`. Поля: campaign dropdown, status, mode, `q` text input с debounce 250ms. **`assignedOperatorId` пикер НЕ добавляем** (Decision 5) — фильтр доступен только через URL deeplink.
- [x] 5.2 Дропдаун кампаний: `useQuery({ queryKey: ['campaigns'], queryFn: () => api.get('/campaigns') })`, сортировка по `name` (`localeCompare`). Опция «Все кампании» = пустое значение.
- [x] 5.3 Чип «Сбросить» (`Clear all`) виден, если хотя бы один фильтр непустой. По клику — `updateFilters({ campaignId: undefined, status: undefined, mode: undefined, q: undefined })` (assignedOperatorId не трогаем — если кто-то открыл по deeplink, остаётся, пока не убран явно из URL).
- [x] 5.4 Если URL содержит `assignedOperatorId`, показать read-only «applied filter» chip с id (или labelом-плейсхолдером) — чтобы оператор видел, почему его инбокс отфильтрован. Дропдаун-пикера нет (нет role-safe lookup'а), но у чипа есть кнопка-крестик «убрать», которая вызывает `updateFilters({ assignedOperatorId: undefined })`. Кнопка `Clear all` (5.3) этот фильтр НЕ трогает — снять его можно только явным кликом по крестику.
- [x] 5.5 Подключить `InboxFilters` в `InboxPage.vue` над `ConversationList`. Сохранить существующий grid layout (заголовок + табы остаются в `ConversationList`).

## 6. Web: счётчики и табы под фильтрованный список

- [x] 6.1 `ConversationList.vue` уже считает все счётчики (`items.length`, табы) от `props.items`; нужный список теперь приходит уже отфильтрованным с API через `InboxPage.vue`. Изменений в `ConversationList.vue` не понадобилось.
- [x] 6.2 Заменён `placeholder for future tabs` комментарий на пояснение, что табы декоративные поверх отфильтрованного `items` (см. `ConversationList.vue:31`).

## 7. Web: CTA «Открыть инбокс кампании»

- [x] 7.1 На `apps/web/src/features/campaigns/CampaignDetailPage.vue` в шапку (`PageHead #actions`) добавлен `<router-link class="btn" :to="{ name: 'inbox', query: { campaignId: campaign.id } }">Инбокс кампании</router-link>` с иконкой `chat`.
- [x] 7.2 Использован существующий стиль `btn` — никаких новых паттернов.

## 8. Тесты UI

- [x] 8.1 vitest unit для `InboxFilters.vue` (`apps/web/src/features/inbox/__tests__/InboxFilters.test.ts`): debounce `q` (single emit после 250ms), Clear-all чистит campaignId/status/mode/q и НЕ трогает assignedOperatorId, deeplink-чип рендерится и убирается через крестик, сортировка по `name`. 6 кейсов.
- [x] 8.2 vitest для `InboxPage.vue` (`apps/web/src/features/inbox/__tests__/InboxPage.test.ts`): пробрасывает filter params в `api.get('/conversations', { params })`; auto-select через `router.replace` с сохранением query; пустой filtered list → нет авто-навигации.
- [x] 8.3 vitest для «selected outside filter»: задан `:conversationId=conv-X`, в отфильтрованном списке только `conv-1` — детальный запрос идёт, `ConversationView` рендерится, empty-state «Выберите диалог» не показывается.
- [ ] 8.4 (опц.) playwright smoke — **пропущено**: e2e-инфраструктура с сидингом кампании и контактов под этот сценарий потребует отдельной подготовки, vitest-уровневое покрытие закрывает ключевые требования spec. Зафиксировано в PR.

## 9. Проверка и докрутка

- [x] 9.1 `pnpm typecheck && pnpm lint && pnpm test` — все 17 пакетов зелёные.
- [ ] 9.2 Локальный `pnpm dev` golden path — **не запущен в этой сессии (требует docker compose up + auth)**, фиксирую в PR как чек-лист для оператора.
- [x] 9.3 `CHANGELOG.md` обновлён: запись «Inbox: per-campaign filter and friends» в `Unreleased / Added`.
- [x] 9.4 `DESIGN.md:97` — описание Inbox дополнено упоминанием фильтров и deep-link от страницы кампании.

## 10. Архив

- [x] 10.1 Архивировано через `/opsx:archive`: спека `inbox-filters` промоутнута в `openspec/specs/`, change перенесён в `openspec/changes/archive/2026-05-24-inbox-campaign-filter/`.
