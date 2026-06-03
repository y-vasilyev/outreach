## Why

Сценарий `agency_sourcing` (агент-аутрич за прайсом/охватами) собран структурно, но в текущей реализации есть пробелы, которые ломают честность сценария и оператора-сейфти-контракт:

- агентский opener может уйти на автоотправку **без реально найденной рекламной интеграции** (worker не читает `auto_send_eligible`, а в `observed_integrations` подаются любые последние посты, не размеченные как sponsored);
- campaign-type safety profile применяется неполно: dispatcher теряет `allowed_topics/forbidden_topics/max_length/allow_links`, а operator approval / direct send вообще не получает safety profile — это нарушает заявленный контракт «любой исходящий проходит safety с учётом campaign_type»;
- `DataCollectionPlanner` читает `ProfileDataPoint` синхронно, тогда как `profile-extract` ставится в очередь асинхронно — на том же тике может переспросить только что присланную информацию;
- `goal.client_brief` из агентского редактора не доходит до opener (worker подсовывает `valueProp`);
- media kit, присланный первым входящим, теряет связь с `BloggerProfile` (на момент сохранения asset профиля ещё нет, backfill отсутствует);
- `GoalFitEvaluator` всё ещё CustDev-центричный и в `semi_auto/auto` может ошибочно оценивать агентскую цель «собрать прайс/охваты»;
- дедупликация opener (`addContacts`) ищет только `opening_composer`, поэтому для агентских кампаний создаёт дубль `pending` opener;
- набор более мелких но реальных дефектов: `observed_integrations` фид без LLM-детектора рекламы; `deals_contact` в дефолтном таргете никогда не помечается собранным; `audience` target keyword накрывает все `audience.*` (пропускаются возраст/пол); extractor запускается на каждом пустом inbound; `RateCardExtractor` префиксует `rate.` к любому полю; кампания типа `agency_sourcing` при выключенном флаге молча работает как CustDev; profile-extract тихо деградирует без retry.

Эти проблемы дают суммарный эффект: «вроде агентский пайплайн есть» → но он либо обманывает блогера придуманной интеграцией, либо повторяется, либо обходит safety. Чинить точечно по одному не нужно — фикс лежит в одной плоскости и должен ехать вместе.

## What Changes

- **Sponsored-integration detection (новый LLM-агент)**. Перед подачей в `agency_opening_composer` посты канала прогоняются через детектор рекламы; opener получает ТОЛЬКО подтверждённые sponsored-интеграции в `observed_integrations`. Никаких regex/erid-фильтров — только LLM-классификация (с verbatim snippet и confidence).
- **Opener auto-send gate.** Worker (dispatcher + agent-run first-message) обязан читать `auto_send_eligible` из варианта opener: неэлигибельные варианты сохраняются как `pending`, но не участвуют в auto-approve, независимо от safety score.
- **Полный safety profile на каждом исходящем.** Dispatcher, on_inbound reply-композер, operator approve и direct send получают одинаковый `safetyExtras` (allowed_topics, forbidden_topics, hard_block_patterns, max_length, allow_links) из `campaign.type.safetyProfile`. Один helper — один вызов.
- **Sync planner ordering.** Для agency-conversation на `on_inbound`: либо `profile-extract` выполняется синхронно перед `DataCollectionPlanner`, либо в planner подаётся текущий inbound + только что извлечённые drafts в качестве «pending-collected», чтобы он не переспрашивал.
- **`client_brief` доходит из goal в opener.** Worker берёт `client_brief` из `campaign.goal.client_brief`, а не из `valueProp`.
- **Media kit backfill.** При создании `BloggerProfile` в `profile-extract` ассоциируются media assets, привязанные к тому же `conversationId` и созданные до появления профиля.
- **`GoalFitEvaluator` campaign-type aware.** Промпт и input включают `campaignType.goalIntent` (или эквивалент из реестра); агентский сценарий оценивается по «сбор прайс/охватов», а не по CustDev-критериям.
- **Opener dedup учитывает agency-вариант.** `addContacts`/проверка существующего opener соответствует имени агента, выбранного через `resolveRoleAgent` (`opening_composer` | `agency_opening_composer`).
- **`deals_contact` либо собирается, либо убирается.** Новый легковесный `deals_contact_extractor` пишет `contact.deals` в `ProfileDataPoint`; либо `deals_contact` уходит из дефолтного `AGENCY_DEFAULT_TARGETS`.
- **`audience` target раздроблен.** `targetCollected` различает `audience_demographics` (age+gender) и `geo`, чтобы наличие `audience.geo` не помечало демографию собранной.
- **Кампания `agency_sourcing` при выключенном флаге — explicit fail.** Либо блокировка создания/run в API, либо assertion+лог в dispatcher, не молчаливый CustDev-fallback.
- **`profile-extract` resilience.** Различает «модель ответила пустым» и «вызов не удался»; во втором случае — throw → BullMQ retry с backoff.
- **Extractor pre-gate.** Дешёвый детерминированный фильтр (есть ли число + currency/format keyword) — пропускает inbound к двум LLM-вызовам только при наличии сигнала.
- **`RateCardExtractor` field guard.** Дропает или нормализует поля не из набора `rate.<format>`; больше не префиксует `rate.` слепо.

## Capabilities

### New Capabilities
- `sponsored-integration-detection`: LLM-агент, размечающий посты канала как sponsored/non-sponsored с verbatim snippet и confidence; единственный валидный источник для `observed_integrations` агентского opener.

### Modified Capabilities
- `agency-sourcing-pipeline`: opener auto-send gate, sync planner ordering, `client_brief` из goal, дробление `audience` target, sponsored-only feed для opener, явный fail при выключенном флаге, extractor pre-gate, retry-семантика, field-guard у `RateCardExtractor`.
- `campaign-type-registry`: контракт «full safety profile применяется к каждому исходящему» — dispatcher first-message, on_inbound reply, operator approve, direct send.
- `blogger-commercial-profile`: media asset backfill при появлении профиля; deals_contact extractor либо явное удаление из дефолтного таргета.
- `media-asset-storage`: при создании `BloggerProfile` media assets с тем же `conversationId` и `profileId=null` подхватываются (backfill).
- `conversation-quality-gate`: `GoalFitEvaluator` принимает campaign-type-aware goal scaffold и промпт; перестаёт оценивать non-CustDev цели CustDev-критериями.
- `opener-ab-variants`: дедупликация и подсчёт opener-варианта учитывают оба имени агента (`opening_composer` и `agency_opening_composer`).

## Impact

- **Код**:
  - `packages/agents/src/agents/SponsoredIntegrationDetector.ts` (новый), `registry.ts`, `agents.seed.ts`.
  - `packages/agents/src/agents/RateCardExtractor.ts`, `DataCollectionPlanner.ts`, `AgencyOpeningComposer.ts` (входы), `GoalFitEvaluator.ts` (промпт/входы).
  - `apps/workers/src/queues/campaign-dispatcher.ts`, `apps/workers/src/queues/agent-run.ts` (opener-gate, full-safety helper, planner ordering, client_brief routing, dedup).
  - `apps/workers/src/queues/profile-extract.ts` (retry semantics, media-kit backfill, pre-gate hook).
  - `apps/workers/src/services/media-store.ts` (backfill query).
  - `apps/api/src/services/conversations.ts`, `apps/api/src/services/campaigns.ts` (operator approve/direct send safety, addContacts opener dedup).
  - `packages/shared/src/feature-flags.ts`, `apps/api/src/services/feature-flags.ts` (валидация type+flag), `packages/shared/src/schemas/ajtbd.ts` (GoalFitEvaluator scaffold).
- **БД**: миграций может не потребоваться — `MediaAsset.profileId` уже nullable; добавление `deals_contact_extractor` идёт через сид `agent_config`.
- **API/контракты**: opener variant теперь обязан нести `auto_send_eligible` на выходе; `SafetyFilter` input единый во всех call-сайтах.
- **Тесты**: `agencyRouting.test.ts`, `profileExtract.test.ts`, `AgencyOpeningComposer.test.ts`, `DataCollectionPlanner.test.ts`, новые `SponsoredIntegrationDetector.test.ts`, тесты operator-approve safety, addContacts dedup, ajtbd scaffold для agency.
- **Фичефлаг**: всё за существующим `agency_sourcing`. Новый агент-детектор включается тем же флагом.
- **Совместимость**: для уже собранных профилей backfill media assets безопасен (UPDATE WHERE profileId IS NULL). Никаких breaking изменений в публичных API.
