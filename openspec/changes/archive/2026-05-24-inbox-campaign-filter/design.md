## Context

Текущее состояние:
- `GET /conversations` уже принимает `ConversationFiltersZ` (`campaignId`, `status`, `mode`, `assignedOperatorId`, `q`) и применяет `campaignId`/`status`/`mode`/`assignedOperatorId` в `conversationsService.list` (`apps/api/src/services/conversations.ts:60`). Поле `q` принимается схемой, но **не используется** в Prisma-запросе.
- Web-инбокс вызывает endpoint без параметров (`apps/web/src/features/inbox/InboxPage.vue:21`), отрисовывает список «как есть», и в `ConversationList.vue:31` есть прямой комментарий: `local-only client filter; placeholder for future tabs`.
- Маршрутизация — Vue Router (`apps/web/src/router/index.ts`): `/inbox` и `/inbox/:conversationId`. `useRoute().query` и `router.replace` доступны.
- Сущность campaign уже доступна через `GET /campaigns`.

Стейкхолдеры: оператор кампании, продакт-менеджер (нужно сравнивать воронки), admin (управление).

Ограничения проекта (см. CLAUDE.md):
- Валидация на границах через `zod`.
- API не дёргает Prisma из роутов — только через сервис.
- Не вводим новый рантайм-флаг без необходимости (изменение не меняет safety/правила).
- Postgres collation по умолчанию case-sensitive, нужен `mode: 'insensitive'` в Prisma `contains`.

## Goals / Non-Goals

**Goals:**
- Оператор может открыть инбокс конкретной кампании одним кликом со страницы кампании.
- Все указанные в schema фильтры реально применяются и комбинируются.
- Состояние фильтров переживает reload и shareable через URL.
- Счётчики в шапке и табах отражают применённый фильтр (то, что видит оператор).
- Минимальные изменения сервисного слоя: одна функция `list`, без новой таблицы/миграции.

**Non-Goals:**
- Сохранённые наборы фильтров / pinned views.
- Server-side пагинация / infinite scroll.
- Сортировки по другим колонкам.
- Bulk-операции над выбранными диалогами.
- Полнотекстовый поиск по телу сообщений (только по contact/channel) — пересечение с логикой логов и `LOG_MESSAGE_BODIES=false`, оставляем за рамками.
- Изменение ролевой модели/расширение видимости viewer.

## Decisions

### Decision 1. URL-based filter state (single source of truth) + push vs replace

Состояние фильтров живёт в `route.query` инбокс-маршрута. **Пользовательские** мутации фильтров (выбор кампании, ввод `q`, переключение status/mode, сброс) — через `router.push({ ..., query: nextQuery })`, чтобы каждый коммит фильтра создавал history-entry и работали back/forward. **Авто-навигация** (выбор первого диалога после загрузки списка) — `router.replace`, чтобы не засорять историю промежуточными состояниями. Это согласовано с текущей реализацией `InboxPage.vue:32` (replace на auto-select).

**Alternatives considered:**
- Везде `router.replace`: shareable ссылки работают, но «сбросил фильтр → нажал Назад» возвращает к URL до открытия инбокса, а не к предыдущему фильтру — оператор теряет контекст.
- Pinia/Vuex стор фильтров — добавляет лишний слой состояния и требует синхронизации с URL в обе стороны.
- `localStorage` — ломает shareable links и удивляет пользователя при открытии в новой вкладке.

**Why:** URL как single source даёт нативную поддержку back/forward, легко делиться ссылками, не требует store; React Query queryKey естественно зависит от query params. Разделение push/replace отражает интенцию: пользовательское действие = шаг истории; деривативная авто-навигация = молча.

### Decision 2. `q` нормализуется на границе и реализуется через Prisma `OR` с `mode: 'insensitive'`

Нормализация — **в zod-схеме** (`ConversationFiltersZ`), а не в сервисе, чтобы соответствовать конвенции «валидация на границах» (CLAUDE.md) и чтобы любой будущий клиент API получил одинаковую семантику:

```ts
const trimToUndef = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v) : v),
  z.string().optional(),
);
export const ConversationFiltersZ = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), ConversationStatusZ.optional()),
  mode: z.preprocess((v) => (v === '' ? undefined : v), ConversationModeZ.optional()),
  campaignId: trimToUndef,
  assignedOperatorId: trimToUndef,
  q: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v),
    z.string().max(200).optional(),
  ),
});
```

Это закрывает codex-замечание про `?status=&mode=` (раньше падало enum-парсингом) и про неограниченную длину `q` (cap 200 защищает от pathological `ILIKE`).

В `conversationsService.list`:
```ts
const where: Prisma.ConversationWhereInput = {
  ...(filters.status && { status: filters.status }),
  ...(filters.mode && { mode: filters.mode }),
  ...(filters.campaignId && { campaignId: filters.campaignId }),
  ...(filters.assignedOperatorId && { assignedOperatorId: filters.assignedOperatorId }),
  ...(filters.q && {
    OR: [
      { contact: { value: { contains: filters.q, mode: 'insensitive' } } },
      { contact: { channel: { handle: { contains: filters.q, mode: 'insensitive' } } } },
      { contact: { channel: { title: { contains: filters.q, mode: 'insensitive' } } } },
    ],
  }),
};
```
Сервис может полагаться на то, что `filters.q` уже trim'нут и не пустой (схема гарантирует).

**Alternatives considered:**
- Тримить в сервисе (как было в первой редакции) — нарушает CLAUDE.md «валидация на границах» и оставляет уязвимость к overlong `q`, если другой клиент дёрнет API напрямую.
- Postgres `tsvector` / `pg_trgm` — overkill для 100-record cap; пересекается с потенциальным «full-text по сообщениям», который вне scope.
- Поиск только по `channel.handle` — оператор часто помнит человекочитаемое имя/title, не handle.

**Trade-off:** при росте таблицы > 50k конверсаций `ILIKE` без индекса начнёт деградировать. До этого далеко (текущий `take: 100`, нет пагинации); если нужно, добавим `pg_trgm` индекс отдельным изменением.

### Decision 3. Декоративные табы становятся пост-фильтром поверх серверного

Существующие табы `all/ai/op/meets` (`ConversationList.vue`) переключают локальный pure-client фильтр поверх отфильтрованного с сервера списка. Счётчики табов считаются от **отфильтрованного** (`items.length`, items, отфильтрованные по `pendingSuggestions/mode`), не от глобального.

**Alternatives considered:**
- Превратить `ai`/`op` в серверные фильтры (`?hasPendingSuggestions=1`, `?mode=manual`). Это удваивает поверхность API и требует расширения `ConversationFiltersZ`. Не нужно для текущей задачи; `mode=manual` уже доступен через основной фильтр.
- Удалить табы полностью — оператор пользуется ими как быстрыми срезами; убирать без замены — регресс.

### Decision 4. Auto-select первого диалога учитывает фильтр; выбор переживает смену фильтра

Существующая логика `InboxPage.vue:28-36` навигирует на первый элемент при пустом `:conversationId`. Менять только так: (а) навигация на `list[0]` теперь сохраняет `route.query` (`router.replace({ name: route.name, params: { conversationId: items[0].id }, query: route.query })`); (б) если применился фильтр и текущий выбранный `conversationId` **не входит** в новый отфильтрованный список, выбор остаётся.

Codex справедливо отметил, что `current = list.value.find(...)` сейчас даст `null` в этом сценарии. Исправляем так: в `InboxPage.vue` уже идёт `useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.get<ConversationDetail>('/conversations/:id') })` (`InboxPage.vue:38-42`) — он даёт нам детальную запись о выбранном диалоге независимо от того, входит ли она в отфильтрованный список. Меняем источник правой панели:
- список слева (`ConversationList`) питается от `list` (отфильтрованного);
- правая панель (`ConversationView` + `ContextPanel`) питается от `details` (или из `list`, если он там есть — обе версии содержат необходимые поля). Чтобы не плодить две формы данных, оставляем `current` как «лучшая известная запись для `conversationId`»: сначала ищем в `list`, при `null` — берём минимальную проекцию из `details`.

Это закрывает codex-замечание Medium 6 и согласовано со scenario «Selected conversation outside the filtered list still renders».

### Decision 5. Источник списка кампаний для дропдауна; assignedOperatorId — без UI-пикера

`InboxFilters.vue` тянет `GET /campaigns` через React Query (`queryKey: ['campaigns']`, тот же ключ, что и в других местах — кэш переиспользуется). Дропдаун показывает `name`, value = `id`. Пустое значение = «все кампании». Отсортировано по `name` (`localeCompare`).

**`assignedOperatorId` дропдаун — НЕ добавляем в этом change.** Codex Medium 7: endpoint `GET /users` (`apps/api/src/routes/users.ts:15`) — admin-only, а инбоксом пользуется operator/viewer. Добавлять admin-only-зависимость в UI, которым пользуются operator/viewer, — либо безмолвно ломает дропдаун у operator (404/403), либо требует расширения видимости users-endpoint, что выходит за scope. Фильтр `assignedOperatorId` остаётся доступным:
- через API напрямую,
- через deep-link `/inbox?assignedOperatorId=<id>` (зафиксировано в spec scenario «Deep link by operator id is honored»),
- TODO в `InboxFilters.vue` ссылается на отдельный change для role-safe operator-lookup.

**Alternatives considered:**
- Отдельный endpoint `GET /campaigns/lookup?summary=1` — пока нет нужды, `GET /campaigns` лёгкий.
- Расширить `GET /users` на operator/viewer — выходит за scope «фильтры инбокса»; видимость пользователей — отдельная политика.

### Decision 6. queryKey React Query

`['conversations', filters]` — при изменении фильтров запрос инвалидируется и идёт заново. `filters` берётся из `computed`, читающего `route.query`. Это автоматом учитывает share-ссылки.

### Decision 6a. `api.get` принимает `{ params }`

Сейчас `api.get` — `(path: string) => request('GET', path)` (`apps/web/src/lib/api.ts:98`), без поддержки query. Все существующие места передают path-как-есть. Расширяем сигнатуру:
```ts
get: <T>(path: string, options?: { params?: Record<string, string | undefined> }) =>
  request<T>('GET', appendQuery(path, options?.params)),
```
`appendQuery` отбрасывает `undefined/null/''`, остальное URL-кодирует, дописывает к существующему query string. Без этой утилиты UI-задачи требовали бы ручного `URLSearchParams` в каждом вызове, что codex отметил как Medium 4.

**Alternatives considered:**
- В каждом вызове строить `URLSearchParams` руками — дублирование, легко забыть отфильтровать пустые значения.
- Перейти на `ofetch`/`axios` — слишком крупное изменение для текущей задачи.

### Decision 7. CTA «Открыть инбокс кампании»

Кнопка `<router-link :to="{ name: 'inbox', query: { campaignId: campaign.id } }">` на странице деталей кампании. Точное место: рядом с заголовком/основными действиями кампании (`CampaignDetail*.vue`).

## Risks / Trade-offs

- **[Риск] case-insensitive `contains` без trgm-индекса медленно на больших таблицах** → Mitigation: при текущем `take: 100` и объёме данных некритично; если профайлер покажет регресс, выносим в отдельный change с `pg_trgm`.
- **[Риск] Регресс auto-select при пустом отфильтрованном списке** → Mitigation: scenario «empty filtered list → empty state, без navigation» закреплён в spec и тесте.
- **[Риск] Пользователь оставил `campaignId` в URL, а кампанию удалили** → API ответит пустым списком (scenario «Unknown campaignId returns an empty list»). UI показывает empty state с подсказкой «Сбросить фильтр».
- **[Риск] Удвоение состояния (URL ↔ локальный ref)** → Mitigation: явное решение из Decision 1 — только URL. В PR-ревью проверяем, что нет локальных `ref`-копий фильтров.
- **[Trade-off] Поиск только по contact/channel, не по тексту сообщений** → согласован с проектным запретом логировать тела сообщений; full-text — отдельный change.

## Migration Plan

Backwards-compatible:
- API уже принимает фильтры — клиенты без них продолжат получать полный список.
- Реализация `q` — чистое добавление в `WHERE`; без `q` поведение не меняется.
- Если в env остался какой-то скрипт, дёргающий `/conversations?campaignId=...`, он начнёт получать корректно отфильтрованный ответ (раньше получал тот же — campaignId уже работал).

Rollback: возврат коммита; новые URL вида `/inbox?campaignId=...` deградируют в «весь инбокс» (query params просто игнорируются предыдущей версией UI).

## Open Questions

- Хотим ли локализованную сортировку списка кампаний в dropdown (ru collation)? — Пока по умолчанию `localeCompare` без явной локали; уточним при дизайн-ревью.
- Нужно ли отображать «pinned» campaign-фильтр в sidebar (рядом с inbox-link)? — Out of scope, оставляем как идею для следующего change.
