## Why

Сейчас `OpeningComposer` и `AgencyOpeningComposer` уже возвращают 2–3 варианта первого сообщения, но варианты безымянные: после safety-фильтра берётся «самый score'овый», результат уходит в `Suggestion(agentName='opening_composer')` без какого-либо стабильного идентификатора варианта, и `Message` не помнит, какой именно вариант улетел. В итоге у оператора нет ответа на простейший продуктовый вопрос «какой опенер чаще получает ответ» — мы оптимизируем промпты вслепую и не отрабатываем уже сделанную композером работу.

Минимальный лоу-риск способ закрыть это — добавить стабильный `variantKey` на стороне композера, протащить его до `Message.openerVariant`, и дать оператору один эндпоинт со счётчиками. Полноценная экспериментальная инфраструктура (`Experiment`, p-value, sample-size) — overkill: масштаб трафика на этом этапе всё равно не позволяет статистически значимых сравнений, а наблюдаемость нужна сейчас.

## What Changes

- **Composer output**: `OpeningComposer` и `AgencyOpeningComposer` SHALL emit `variantKey: string` (стабильный идентификатор: для дефолтного промпта — `A`, `B`, `C…`; кастомные промпты могут проставлять семантику вроде `concise` / `value_prop`). LLM-выход дополняется опциональным `variant_key`; если LLM не вернул — детерминированный пост-процесс присваивает `A/B/C…` по индексу. Existing `variants[]` shape остаётся, добавляется одно поле.
- **Suggestion meta**: при создании `Suggestion(agentName='opening_composer'|'agency_opening_composer')` `meta.openerVariant = variantKey` для всех вариантов, дошедших до safety-pass. `Suggestion.meta` уже `Json` — миграция не нужна.
- **Message column**: `Message.openerVariant String?` — заполняется при создании outbound-сообщения из opener-suggestion (auto-approve и operator-approve путях). Для не-opener-сообщений `null`. Новая миграция `9e_opener_variant`.
- **Stats endpoint**: `GET /campaigns/:id/opener-stats?withinHours=48` → `{ variantKey, sent, replied, replyRate }[]`. `replied` = есть ли хоть один inbound в той же conversation в течение `withinHours` после отправки opener-сообщения. `withinHours` дефолт 48, диапазон 1–720.
- **Никаких новых агентов, моделей, p-value, sample-size, experiment-инфраструктуры.** Если позже понадобится формальный эксперимент — отдельный change.

## Capabilities

### New Capabilities
- `opener-ab-variants`: composer→suggestion→message протаскивание стабильного `variantKey` опенера + read-only stats-эндпоинт со счётчиками sent/replied/replyRate per variantKey per campaign.

### Modified Capabilities
Нет — стат-эндпоинт сидит рядом с `/campaigns/*`, который не имеет своей capability-спеки, поэтому весь контракт лежит в новой capability `opener-ab-variants`. Существующие capabilities (`chat-autonomy-modes`, `conversation-quality-gate`, `agency-sourcing-pipeline`) не меняют своих требований: variantKey проходит сквозь auto-approve и operator-approve путей как pass-through-метаданные, без изменения safety/gate/handoff поведения.

## Impact

- **Файлы**:
  - `packages/agents/src/agents/OpeningComposer.ts` — добавить `variant_key` в `openingComposerOutputSchema`, детерминированный пост-процесс присвоения `A/B/C…`.
  - `packages/agents/src/agents/AgencyOpeningComposer.ts` — то же + не ломать `auto_send_eligible` guard.
  - `packages/agents/src/agents/__tests__/` — unit-тесты на варианты с и без `variant_key` от LLM.
  - `apps/workers/src/queues/campaign-dispatcher.ts` — пробросить `variantKey` в `Suggestion.meta` при создании opener-suggestion.
  - `apps/workers/src/queues/agent-run.ts` — то же в `handleOutreachFirstMessage`.
  - `apps/workers/src/services/auto-approve.ts` — при создании `Message` из opener-suggestion прочитать `meta.openerVariant` и записать `Message.openerVariant`.
  - `apps/api/src/services/conversations.ts` — `sendOperatorMessage` / `approveSuggestion`: тот же pass-through `Message.openerVariant`.
  - `packages/db/prisma/schema.prisma` — `Message.openerVariant String?` + index `(conversationId, openerVariant)`.
  - `packages/db/prisma/migrations/9e_opener_variant/migration.sql` — ALTER TABLE + индекс.
  - `packages/shared/src/schemas/opener-stats.ts` — новый файл: `OpenerStatsQueryZ`, `OpenerStatsRowZ`, `OpenerStatsZ`.
  - `apps/api/src/services/opener-stats.ts` — новый сервис: `getCampaignOpenerStats(campaignId, withinHours)`.
  - `apps/api/src/routes/campaigns.ts` — добавить `GET /campaigns/:id/opener-stats`.
  - `apps/api/src/services/__tests__/opener-stats.test.ts` — unit-тесты сервиса.
  - `CHANGELOG.md` — `### Added`.
- **Прод-деплой**: миграция БД (новая колонка nullable, обратносовместима) + рестарт API/workers. Никаких feature flags — фича read-only side-effect от уже работающих композеров.
- **Риски**:
  - Если LLM начнёт возвращать осмысленные `variant_key` (`'short'`), а потом изменится промпт и они станут другими — статистика будет смешивать варианты разных версий промпта. Митигация: stats endpoint не претендует на статистическую значимость, это операционный счётчик. Если оператор меняет промпт — он видит новые ключи и старые в одном отчёте, что само по себе диагностично.
  - `replyRate` без attribution-логики: любой inbound в окне считается «ответом», даже если он на следующее outbound. Это устраивает scope (см. design.md decision 2), но это документированное упрощение.
- **Тесты**: unit ≥ 70% веток для нового сервиса и измёненных композеров. Не нужны e2e — операторской UI этой фичи нет в scope.
