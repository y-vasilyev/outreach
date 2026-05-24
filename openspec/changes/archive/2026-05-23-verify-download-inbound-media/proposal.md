## Why

`packages/tg-client/src/SessionManager.ts` реализует `downloadInboundMedia(opts)` — обёртку над GramJS `getMessages(...)` + `downloadMedia(...)`, которую вызывает `apps/workers/src/queues/tg-listen.ts` для подгрузки байтов прикреплённого инбаунд-медиа в `media-store` (за runtime-флагом `object_storage`). Контракт хорошо продуман (любая ошибка → `null`, без degradation сессии; mediaStore пишет honest-pending запись вместо мёртвой URL), но на момент мержа этого hotfix-блока:

- **Нет ни одного unit-теста** конкретно на `downloadInboundMedia` в `packages/tg-client`. Архитектура каждой ветки (no media / no downloadMedia / Uint8Array / string / Buffer / null / throw) проверяется только косвенно через `apps/workers/src/__tests__/mediaStore.test.ts`, который мокает downloadBytes-thunk целиком.
- **Не было живой проверки** против реального TG-аккаунта (этого требует пилот). Это операционный шаг, требующий залогиненной сессии; в код-репо я его не могу выполнить.

Перед prod-запуском надо: (а) убедиться, что каждая ветка контракта работает как задумано, (б) дать оператору пошаговый smoke-чеклист для исполнения с реальной сессией.

## What Changes

- **Новый юнит-тест** `packages/tg-client/src/__tests__/downloadInboundMedia.test.ts`, который покрывает все ветки `downloadInboundMedia`:
  - (Note: `requireAuth()` остаётся в handle-wrapper'е до делегата — out of scope для тестов чистого хелпера; тесты `downloadInboundMediaWithClient` стартуют сразу с момента вызова с уже подменённым клиентом.)
  - `Number(tgMsgId)` не число → `null`.
  - GramJS вернул пустой массив / `undefined` → `null`.
  - Сообщение без `media` → `null`.
  - `client.downloadMedia` отсутствует на клиенте → `null`.
  - `downloadMedia` бросает → `null` (с warn-логом).
  - `downloadMedia` вернул `null`/`undefined` → `null`.
  - `downloadMedia` вернул `Uint8Array` → байты возвращаются как есть.
  - `downloadMedia` вернул `string` → конвертация через TextEncoder.
  - `downloadMedia` вернул `Buffer` (как Uint8Array-subclass) → байты.
  - `downloadMedia` вернул нечто иное (например, объект) → `null`.
- **RUNBOOK** в самой change-папке — пошаговый сценарий для оператора: создать диалог → отправить файл → проверить, что в `MediaAsset` строка с непустым `s3Key` появилась. Покрывает оба исхода: success (s3Key, presigned URL валиден) и honest-pending (s3Key='', degraded='no_bytes' — например при отсутствии S3 ключей либо когда GramJS `downloadMedia` вернул null).
- **Минимальный рефактор**: тело `downloadInboundMedia` извлечено в экспортируемый чистый хелпер `downloadInboundMediaWithClient(client, tgAccountId, opts)` с узким интерфейсом `DownloadMediaClient` (`getMessages`, опциональный `downloadMedia`). Handle делегирует в него — поведение не меняется, но функция становится тестируемой в изоляции без поднятия `SessionManager`.

## Capabilities

### New Capabilities
Нет.

### Modified Capabilities
- `media-asset-storage`: дельта-спека уточняет, что контракт `downloadInboundMedia` юнит-тестирован через мок GramJS-клиента, а живая верификация описана в RUNBOOK.

## Impact

- **Файлы**:
  - `packages/tg-client/src/SessionManager.ts` — минимальный рефактор: тело `downloadInboundMedia` вынесено в экспортируемый `downloadInboundMediaWithClient(...)`; handle делегирует. Plus экспортируется тип `DownloadMediaClient`.
  - `packages/tg-client/src/__tests__/downloadInboundMedia.test.ts` — новый.
  - `openspec/changes/verify-download-inbound-media/RUNBOOK.md` — новый.
  - `openspec/specs/media-asset-storage/spec.md` — дельта.
  - `CHANGELOG.md` — запись в `## Unreleased → ### Changed`.
- **Код** — поведение `downloadInboundMedia` не меняется (рефактор сохраняет ту же ветвистость и тот же возвращаемый тип).
- **Тесты** — `pnpm test --filter @nosquare/tg-client` будет покрывать новый файл; общая регрессия должна остаться зелёной.
- **Live smoke** остаётся ручной задачей оператора; задача данного change'а — облегчить её и зафиксировать ожидания.
- **Риски** — нулевые. Только новые тесты + документация.
