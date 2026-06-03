## Context

`agency_sourcing` пайплайн уже собран: `AgencyOpeningComposer` пишет первый коммерческий заход, `DataCollectionPlanner` ведёт диалог, `RateCardExtractor`/`AudienceStatsExtractor` пишут `ProfileDataPoint`, роллап агрегирует в `BloggerProfile`. Что выявлено при ревью (см. proposal):

- opener-вариант помечается `auto_send_eligible`, но worker auto-approve выбирает кандидата только по safety score (`apps/workers/src/queues/agent-run.ts:827`, `apps/workers/src/queues/campaign-dispatcher.ts:346`) — поле игнорируется;
- `observed_integrations` фид содержит произвольные последние посты (`apps/workers/src/queues/agent-run.ts:795`, `apps/workers/src/queues/campaign-dispatcher.ts:315`), нет агента/детектора рекламы;
- dispatcher передаёт SafetyFilter только `hard_block_patterns` (`apps/workers/src/queues/campaign-dispatcher.ts:299`), operator approve/direct send даже этого не делает (`apps/api/src/services/conversations.ts:21`, `apps/api/src/services/conversations.ts:405`);
- `profile-extract` ставится в очередь (`apps/workers/src/queues/agent-run.ts:362`), `DataCollectionPlanner` синхронно читает старый `BloggerProfile` (`apps/workers/src/queues/agent-run.ts:276`) — переспрашивание гарантированно;
- agency goal-editor пишет `client_brief` в goal (`apps/web/src/features/campaigns/AgencyGoalEditor.vue:7`), worker подсовывает `valueProp` (`apps/workers/src/queues/agent-run.ts:794`, `apps/workers/src/queues/campaign-dispatcher.ts:314`);
- media asset ищет существующий профиль (`apps/workers/src/services/media-store.ts:77`); profile-extract создаёт его позже без backfill (`apps/workers/src/queues/profile-extract.ts:129`);
- `extractAjtbdView` для non-custdev строит scaffold из `goalText/valueProp` (`packages/shared/src/schemas/ajtbd.ts:84`), `GoalFitEvaluator` промпт CustDev-центричный (`packages/agents/src/agents/GoalFitEvaluator.ts:73`);
- `addContacts` дедуп ищет только `opening_composer` (`apps/api/src/services/campaigns.ts:330`), агентский suggestion сохраняется как `agency_opening_composer` (`apps/workers/src/queues/agent-run.ts:859`);
- `AGENCY_DEFAULT_TARGETS` включает `deals_contact`, для которого нет экстрактора (`apps/workers/src/queues/agent-run.ts:238–260`); `audience` keyword совпадает со всем `audience.*`; `RateCardExtractor` слепо префиксует `rate.` (`packages/agents/src/agents/RateCardExtractor.ts:109`); `profile-extract` тихо возвращает `{ok:true}` при ошибке (`apps/workers/src/queues/profile-extract.ts:120–122`).

Ограничения:
- Никакого regex/heuristic-детектора рекламы — детекция через LLM-агент (`SponsoredIntegrationDetector`) как и остальные классификаторы; provenance + verbatim snippet.
- Всё под существующим фичефлагом `agency_sourcing`; флаги не плодим.
- Без миграции БД: `MediaAsset.profileId` уже nullable; новый агент добавляется через сид.
- Сохранить CustDev-путь побайтово (см. `chat-autonomy-modes` спек), не задеть его регрессом.

## Goals / Non-Goals

**Goals:**
- Закрыть все 7 находок ревью (3 High, 3 Medium, 1 Low) одним согласованным набором правок.
- Один helper `resolveSafetyInput(campaign)` используется во ВСЕХ call-сайтах SafetyFilter (dispatcher, on_inbound, operator approve, direct send); regression test пинит, что они эквивалентны.
- Opener никогда не уходит на авто-отправку без LLM-подтверждённой sponsored-интеграции; вариант без подтверждённой интеграции остаётся `pending` для оператора.
- `DataCollectionPlanner` видит факты текущего входящего на том же тике (не переспрашивает только что присланное).
- Все операционные исправления (deals_contact, audience drill-down, RateCardExtractor field-guard, profile-extract retry, extractor pre-gate, fail-fast при выключенном флаге) — точечно, без перепроектирования агентов.

**Non-Goals:**
- PDF/OCR медиакитов (отдельный change, `media-asset-parsing`).
- UI для review низко-confidence фактов (вне scope этой пачки).
- Изменения формы `BloggerProfile`/`ProfileDataPoint`/`MediaAsset` (модель остаётся).
- Любой regex/markers-based ad-detector — отвергнут пользователем, только LLM-агент.

## Decisions

### D1. Sponsored-integration детектор — отдельный LLM-агент

**Решение.** Ввести агент `sponsored_integration_detector` (`packages/agents/src/agents/SponsoredIntegrationDetector.ts`) с контрактом:
- Вход: `posts: {date?, text}[]` (до 10–15), `channel_title`, `language`.
- Выход: `integrations: [{ snippet, brand?, date?, confidence, rationale }]` — только посты, классифицированные как sponsored, с verbatim `snippet`.
- Дефолтная модель — `anthropic/claude-haiku-4.5` (дешёвая классификация), low temperature.
- Регистрация в `registry.ts`, сид с system+user промптами в `agents.seed.ts`.

Места вызова — dispatcher first-message и `agent-run handleOutreachFirstMessage`. Перед обращением к `agency_opening_composer`:
```ts
const detected = await runAgentSafe<SponsoredOut>('sponsored_integration_detector', { posts: recentPosts, channel_title, language }, ctx);
const observed_integrations = (detected?.integrations ?? []).filter(i => i.confidence >= MIN_CONF);
```
`MIN_CONF` = 0.6 (порог обсуждаем в Open Questions). Если детектор упал/вернул пусто → `observed_integrations: []` → деталь-фабрикейшен-guard у composer'а корректно вырубит `auto_send_eligible`.

**Альтернативы.**
- Regex/erid/`#реклама` маркеры — отвергнуто пользователем явным образом.
- Расширить `ChannelAnalyzer`, чтобы попутно эмитил sponsored-флаг на пост — увеличит ответственность одного агента и сделает его тяжелее; разделение проще тестировать и кэшировать.
- Сохранять детекцию в `channel.rawData.posts[i].sponsored` для повторного использования — оптимизация на потом; в первой итерации зовём при каждой first-message, как остальные опенер-агенты.

### D2. Opener auto-send gate

**Решение.** В обоих call-сайтах opener (`campaign-dispatcher.ts` и `agent-run.ts handleOutreachFirstMessage`) логика выбора лучшего варианта дополняется фильтром:
```ts
const eligible = opener.variants.filter(v => v.auto_send_eligible !== false);
// auto-approve loop работает только по `eligible`; не-eligible варианты всё равно
// сохраняются как pending suggestion (оператор видит, но автоотправки нет).
```
Поле `auto_send_eligible` уже на `OpeningComposer`/`AgencyOpeningComposer` выходе; общий тип `OpenerOut` расширяем до `auto_send_eligible?: boolean` (CustDev opener сегодня не выставляет — `undefined` ≡ true для совместимости).

**Альтернативы.**
- Игнорировать поле в CustDev и читать только в agency — асимметрия, плохо тестируется; выбираем единое поведение.
- Жёстко требовать `cited_integration` присутствует в тексте на стороне worker — уже сделано в самом композере (`AgencyOpeningComposer.ts:235–269`), worker должен только уважать его вывод.

### D3. Полный safety profile через единый helper

**Решение.** Завести `apps/workers/src/services/safety-input.ts` и его API-аналог `apps/api/src/services/safety-input.ts` (или общий в `packages/shared`) с функцией:
```ts
function buildSafetyInput(args: {
  draft: string;
  campaign: CampaignLite | null;
  channelAnalysis?: unknown;
  contactId?: string;
}): SafetyFilterInput;
```
Внутри читает `safetyExtras = safetyExtrasForCampaign(campaign)` (уже есть) и заполняет `allowed_topics`, `forbidden_topics`, `hard_block_patterns`, `max_length`, `allow_links`. Все четыре call-сайта SafetyFilter (`campaign-dispatcher.ts:347`, `agent-run.ts` two sites, `apps/api/src/services/conversations.ts` operator approve + direct send) переходят на этот helper. Regression test: набор полей передаваемых SafetyFilter одинаков во всех путях.

**Альтернативы.**
- Дописать в каждом call-site руками — текущее состояние, легко расходится. Отвергнуто.
- Сделать SafetyFilter ctx-aware (грузить campaign по conversationId внутри агента) — увеличит coupling агента, против архитектуры.

### D4. Sync ordering planner и profile-extract

**Решение.** В `handleOnInbound` для agency-conversation вместо постановки `profile-extract` в очередь — вызвать `handleProfileExtract` синхронно ДО `DataCollectionPlanner`:
```ts
if (isAgencyConversation(conv.campaign)) {
  await handleProfileExtract({ conversationId: conv.id, sourceMessageId: last.id });
  // profile уже обновлён, planner читает свежий снимок
}
```
Это согласуется с уже сделанным дизайн-инвариантом profile-extract («атрибутируем точки к одному `sourceMessageId`»). BullMQ-воркер `profile-extract` сохраняется для on-demand/manual вызовов; новый путь — прямой вызов функции (она уже экспортирована).

`handleProfileExtract` уже идемпотентен относительно sourceMessageId? — почти: `bloggerProfile.upsert` ok, но `profileDataPoint.create` создаст дубли при повторном вызове. Решение: использовать `findFirst({ where: { profileId, sourceMessageId, field } })` перед `create`, либо завести уникальный индекс `(profileId, sourceMessageId, field, extractedBy)`. Уникальный индекс — миграция, проще оставить `findFirst+create` (выполняется в той же транзакции, race не возможен — один воркер).

**Альтернативы.**
- Передавать planner-у текущий inbound + только что извлечённые drafts как «pending-collected», не дожидаясь записи в БД. Сложнее: меняем сигнатуру `agencyTargets/collectedAgencyTargets`, путаем источники истины.
- Дублировать вызов экстракторов внутри planner — двойные LLM-вызовы.

### D5. `client_brief` из goal

**Решение.** В `campaign-dispatcher.ts` и `agent-run.ts handleOutreachFirstMessage` для агентского opener'а:
```ts
const clientBrief =
  (typeof goal === 'object' && goal && typeof (goal as any).client_brief === 'string'
    ? (goal as any).client_brief
    : '') || c.valueProp || '';
```
То есть приоритет: `goal.client_brief` → `valueProp` → пусто. `valueProp` остаётся фоллбеком на случай старых кампаний без миграции goal. Zod-схема goal у `agency_sourcing` (`packages/db/prisma/seed.ts:286–290`) расширяется/уточняется явным `client_brief: z.string().default('')`.

### D6. Media kit backfill

**Решение.** Внутри транзакции `handleProfileExtract` (после `bloggerProfile.upsert`):
```ts
await tx.mediaAsset.updateMany({
  where: { conversationId: conv.id, profileId: null },
  data: { profileId: profile.id },
});
```
Это охватывает кейс «media kit пришёл первым входящим, профиль ещё не существовал». Никаких изменений в `media-store.ts` (он продолжает писать `profileId=null` если профиля нет).

**Альтернативы.**
- Создавать профиль на первом media-asset event — раздувает ответственности media-store; backfill симметричнее.

### D7. `GoalFitEvaluator` campaign-type aware

**Решение.** Расширить вход агента (`GoalFitEvaluatorInputZ`) опциональным `campaign_type: { key, goalIntent, allowed_topics, examples_collect }` (берём из `campaign.type`). Промпт получает branch:
- если `campaign_type.key === 'agency_sourcing'` (или goalIntent='collect_commercial_data') — критерий «диалог двигается к сбору одного из target_data_points; не уходит в продажу клиента/предоплату/обещания»;
- иначе — текущая CustDev-формулировка.

`extractAjtbdView` (`packages/shared/src/schemas/ajtbd.ts:84`) дополняется веткой: для non-custdev строит scaffold не только из `goalText/valueProp`, но и из `campaign.type.goalSchema` (например, `target_data_points`).

**Альтернативы.**
- Завести отдельный агент `AgencyGoalFitEvaluator` — лишний агент, тестировать вдвое больше; ветвление промпта достаточно.

### D8. Opener dedup для обоих агентов

**Решение.** В `apps/api/src/services/campaigns.ts:330` (и любых других `where: { agentName: 'opening_composer' }`) использовать `agentName: { in: ['opening_composer', 'agency_opening_composer'] }`. Дополнить общий helper `OPENER_AGENT_NAMES = ['opening_composer','agency_opening_composer'] as const` в `packages/shared/src/agent-roles.ts`, чтобы добавление будущих ролей было one-liner.

### D9. Точечные правки

- **`deals_contact`.** Минимальная итерация: убрать из `AGENCY_DEFAULT_TARGETS`. Полноценный extractor (как новый агент) — отдельный последующий change, чтобы текущий не разбухал. Если кампания явно ставит `target_data_points: ['deals_contact', ...]`, planner закроет на caned reply без записи в profile (документируем как known limitation в spec).
- **`audience` keyword drill-down.** В `TARGET_FIELD_KEYWORDS`:
  ```ts
  audience: ['audience.age','audience.gender','audience.geo'],
  audience_demographics: ['audience.age','audience.gender'],
  geo: ['audience.geo'],
  ```
  `targetCollected` уже использует `startsWith(`${k}.`)|=== k|.includes(k)`; меняем семантику на строгий match по точному полю.
- **Agency-флаг fail-fast.** В `apps/api/src/services/campaigns.ts` при создании кампании с `type.key === 'agency_sourcing'` проверять `getFeatureFlags().get('agency_sourcing')` — если off, `AppError('AGENCY_SOURCING_DISABLED', 422)`. В dispatcher/on_inbound добавить warn-лог при mismatch.
- **`profile-extract` resilience.** В `handleProfileExtract`: `if (!rate && !audience) throw new Error('extractors failed')` (BullMQ retry). На прямом синхронном вызове из `agent-run.ts` обрабатываем catch → отдельный лог, не валим inbound.
- **Extractor pre-gate.** Простой детерминированный детектор `hasCommercialSignal(text: string)` в `packages/shared/src/agency-detect.ts`: regex `/\d/`, валюта/тыс/k, формат-слова, охват-слова. Если нет — пропускаем экстракторы (degraded='no_signal'). Это НЕ ad-detector; это фильтр «есть ли в тексте хоть какая цифра/формат-слово».
- **`RateCardExtractor` field guard.** В пост-process: если `dp.field` не матчит `^rate\.[a-z_]+$`, либо записывать `rate.other`, либо дропать. Текущий слепой префикс убираем.

## Risks / Trade-offs

- **[Latency]** Sync `handleProfileExtract` на `on_inbound` добавляет 2 LLM-вызова к тику ответа (rate + audience), плюс детектор спонсорки на first-message. Увеличит p95 inbound→reply на ~1–3 сек.
  → Mitigation: extractor pre-gate (D9) отрезает большинство turn'ов; модели — Haiku/Gemini Flash; вызовы параллельны.
- **[Дубль провенанса]** Sync вызов в той же транзакции означает, что failed-after-write retry не сработает.
  → Mitigation: запись в БД идёт только когда оба экстрактора вернули результат; при ошибке откатываем и логгируем — на следующий inbound retry естественный.
- **[Sponsored-детектор пропускает интеграцию]** False-negative детектора задушит честный hook («был реальный пост, но детектор не уверен») и opener уйдёт на generic / не-eligible.
  → Mitigation: невысокий порог (0.6), variants ≥1 — generic-hook остаётся валидным; рассматриваем как «безопасный недо-call», лучше чем фабрикация.
- **[GoalFitEvaluator ветвление промпта]** Дополнительная ветка усложнит регресс-тесты.
  → Mitigation: тесты по типам кампании отдельными describe-блоками; общий контракт у выхода тот же.
- **[Совместимость opener variant shape]** CustDev `OpeningComposer` сегодня не эмитит `auto_send_eligible`. Добавление optional поля + дефолт `undefined ≡ eligible` не ломает.
- **[Кросс-команда `addContacts` dedup]** Изменяем where-clause на `in [...]`. Существующие pending-suggestion с `agentName='opening_composer'` под агентскую кампанию (не должно быть, но если есть) будут считаться существующими — это и есть желаемое поведение.

## Migration Plan

1. **Phase A — safety + opener gate (без рисков для пользователя).** D2, D3, D8, D9 (кроме pre-gate). PR / коммит, тесты зелёные.
2. **Phase B — sponsored detector + opener feed.** D1, переключение `observed_integrations` на вывод детектора. Под фичефлаг `agency_sourcing` — пока off, изменения не активны.
3. **Phase C — sync planner + media backfill.** D4, D6. Затрагивает hot path inbound; катим под существующим флагом, на демо-инстансе сначала.
4. **Phase D — GoalFitEvaluator + клиент-брифа + точечные.** D5, D7, D9 pre-gate, RateCardExtractor guard. Безопасно.
5. **Rollback.** Каждый PR — самодостаточный; для phase B возможен hard rollback переключением фичефлага off.

## Open Questions

1. **Порог `MIN_CONF` для sponsored-детектора** — 0.6 предлагается, но имеет смысл прогнать на размеченном наборе (10–20 каналов с известным mix sponsored/organic). До этого 0.6 — рабочий дефолт.
2. **Уникальный индекс `(profileId, sourceMessageId, field, extractedBy)`** — нужен ли для бронированной идемпотентности? Если решим использовать sync-вызов из inbound + manual retry через BullMQ, имеет смысл добавить миграцией. По умолчанию делаем `findFirst → create` без миграции.
3. **Backfill media assets — до какого окна назад?** Сейчас предлагается `WHERE conversationId = ? AND profileId IS NULL` без ограничения по времени; для длинных диалогов это корректно, но захватит assets, которые оператор намеренно отвязал. Альтернатива: window по `createdAt > conversation.createdAt`.
4. **`deals_contact` — оставить заглушку или сразу новый extractor?** В этом change — убираем из дефолта (см. D9). Если решим тащить extractor сюда — раздуем scope; предлагаю отдельный follow-up change.
5. **Кто отвечает за UI «pending eligibility»?** Сейчас `auto_send_eligible=false` молча оставляет suggestion как pending. Возможно, нужна виз. подсветка оператору, но это вне scope (web change).
