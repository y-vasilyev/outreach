## 1. Подготовка

- [x] 1.1 Изучить публичную поверхность `tg-client` — как тесты ходят через handle (`tg.for(...)`), как мокается нижележащий GramJS. Найти ближайший аналог-тест (например, фикстуру в `packages/tg-client/__mocks__/MTProto.ts`).
- [x] 1.2 Зафиксировать все ветки в `SessionManager.ts#downloadInboundMedia` (≈10 кейсов: invalid msgId / no messages / no media / no downloadMedia / throw / null / Uint8Array / string / Buffer / other type).

## 2. Юнит-тесты

- [x] 2.1 Создать `packages/tg-client/src/__tests__/downloadInboundMedia.test.ts`.
- [x] 2.2 Использовать тот же подход, что и в существующих тестах tg-client (`RateLimiter.test.ts`, `classifyTgError.test.ts`) — без живого GramJS, с подменённым клиентом.
- [x] 2.3 Покрыть все ветки контракта; убедиться, что метод никогда не выбрасывает.

## 3. RUNBOOK live smoke

- [x] 3.1 Создать `openspec/changes/verify-download-inbound-media/RUNBOOK.md`.
- [x] 3.2 Описать пошагово: какие env'ы нужны (`TG_API_ID`, `TG_API_HASH`, `TG_SESSION_STRING` или логин через админку), как поднять `object_storage` runtime-флаг и MinIO, как отправить медиа в тестовый диалог, как проверить запись в `media_asset` (psql + s3 presigned URL).
- [x] 3.3 Описать варианты выхода: success (s3Key непустой, presigned URL отдаёт байты) и honest-pending (s3Key пустой, причина в `extra`).

## 4. Регрессия

- [x] 4.1 `pnpm typecheck` зелёный.
- [x] 4.2 `pnpm test --filter @nosquare/tg-client` — новый файл проходит, остальные не сломаны.
- [x] 4.3 `pnpm test` — общая регрессия.

## 5. Документация

- [x] 5.1 `CHANGELOG.md` → `## Unreleased → ### Changed`: одна строка про юнит-тесты + runbook.

## 6. Ревью и архив

- [x] 6.1 Codex review (синхронно через `codex-companion.mjs task`).
- [x] 6.2 Применить замечания.
- [x] 6.3 `openspec archive verify-download-inbound-media --yes`.
- [x] 6.4 Закоммитить: `test(tg-client): cover downloadInboundMedia branches + smoke runbook`.
