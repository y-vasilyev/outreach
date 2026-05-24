# RUNBOOK — verify-download-inbound-media (live smoke)

Шаги для оператора, когда уже залогинен outreach TG-аккаунт (`status='active'`, `role IN ('outreach','both')`) и нужно убедиться, что инбаунд-медиа реально скачивается и сохраняется в S3/MinIO. Парсер-аккаунт для smoke'а **не подходит** — `tg-listen` его не подписывает.

## Pre-requisites

1. **TG account залогинен и подписан tg-listen'ом**:
   - В `.env`: заполнены `TG_API_ID`, `TG_API_HASH`. Опционально `TG_SESSION_STRING`, либо логин через админку (`Settings → TG accounts → Login`).
   - В БД должна быть строка `TgAccount` со `status='active'` И `role IN ('outreach','both')` — иначе `tg-listen` её не подпишет (см. `apps/workers/src/queues/tg-listen.ts:303-304`). Парсер-аккаунт по умолчанию имеет `role='parser'` и НЕ подписывается на входящие — для smoke'а нужен outreach-аккаунт.
2. **Object storage поднят**:
   - `docker compose -f infra/compose.dev.yml up minio` (или прод-S3).
   - В `.env`: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=true` (для MinIO).
   - Bucket существует: `docker exec outreach-minio mc alias set local http://localhost:9000 minioadmin minioadmin123 && docker exec outreach-minio mc mb -p local/outreach-media`.
3. **Runtime-флаг включён**:
   - В админке `Settings → Features` включить `object_storage`. Или через psql:
     ```sql
     UPDATE "FeatureFlag" SET enabled=true WHERE key='object_storage';
     ```
     + `docker exec outreach-redis redis-cli PUBLISH feature_flags:changed '*'`.
4. **Воркеры запущены**:
   - `pnpm dev:workers` или `docker compose up workers`. В логах должно быть `tg-listen: subscribed for tg account ...`, а НЕ warning `inbound media skipped: object storage disabled`.

## Smoke

1. **Создай тестовый диалог в TG**: с другого TG-аккаунта (например, твой личный) напиши на **outreach-аккаунт, выбранный в пререке** (status=active, role IN outreach/both) — любую короткую фразу. Это создаст строку `Conversation` в БД.
2. **Отправь медиа**: фото или документ (например, картинку 200KB или PDF на 500KB).
3. **Подожди 5–10 секунд** (tg-listen → mediaStore → S3 upload — асинхронно).
4. **Проверь БД** (актуальные поля `MediaAsset`: `s3Key`, `bytes`, `sha256`, `mime`, `kind`, `sourceTgMsgId`):

   ```bash
   docker exec outreach-postgres psql -U outreach -d outreach -c '
     SELECT id, "conversationId", kind, "s3Key", bytes, sha256, mime, "sourceTgMsgId", "createdAt"
     FROM "MediaAsset"
     ORDER BY "createdAt" DESC
     LIMIT 5;
   '
   ```

   **Success path** (downloadInboundMedia вернул байты, S3 принял):
   - `s3Key` — НЕпустая строка вида `conversations/<conversationId>/<assetId>` (или `bloggers/<profileId>/<assetId>` для blogger-привязанной), см. `packages/storage/src/index.ts#mediaAssetKey`.
   - `bytes` > 0.
   - `sha256` — непустая (заполняется только когда байты реально записаны).
   - В логах воркера: `inbound media asset recorded` с `hasBytes: true`.

   **Honest-pending path** (downloadInboundMedia вернул `null`, либо S3 не настроен):
   - `s3Key = ''` (пустая строка — NOT-NULL sentinel).
   - `bytes` = либо `null`, либо `media.bytes` из TG-метаданных (если был).
   - `sha256 = null`.
   - В логах воркера один из двух warn'ов (оба ведут к `degraded: 'no_bytes'`):
     - `inbound media: byte download unavailable; recorded metadata-only media_asset (s3Key empty)` — когда `downloadBytes` вернул null/пусто (downloadInboundMedia не смог скачать байты).
     - `inbound media: storage flag on but config absent; recorded metadata-only media_asset` — когда байты есть, но `getObjectStore()` вернул null (флаг ON, но S3-конфиг неполный).

5. **Проверь сам файл в S3 (опционально)** — only для success path:

   ```bash
   docker exec outreach-minio mc ls --recursive local/outreach-media/conversations/ | head
   ```

   Размер файла в MinIO ≈ `bytes` из БД.

6. **Сгенерируй presigned URL и скачай**:
   - Через API (admin/operator only): `GET /media-assets/:id/download-url` → возвращает `{ url, expiresInSeconds }`.
   - Curl-пример (TTL опциональная, 30–3600 секунд):
     ```bash
     TOKEN=...   # admin/operator JWT
     ASSET_ID=...
     curl -s -H "Authorization: Bearer $TOKEN" \
       "http://localhost:4000/media-assets/$ASSET_ID/download-url?ttl=600" | jq .
     ```
   - Открой URL в браузере (или `curl -O`) → файл должен скачаться, размер совпадает с `bytes`.

## Чего НЕ должно быть

- Диалог не должен встать (status стать `failed`/`stale`) даже если media download упал.
- В логах воркера допустимы:
  - `tg-listen: media byte download failed; honest-pending asset` — это OK, контракт.
  - `tg-listen: media persistence threw; ignoring (inbound continues)` — тоже OK.
  - `inbound media: byte download unavailable; recorded metadata-only media_asset` — OK.
- Чего быть НЕ должно: `unhandled rejection`, `Error: downloadInboundMedia ...` без `[tg-client]` префикса, или Conversation в `failed`-статусе из-за media.

## Если что-то пошло не так

1. **`s3Key` всегда пустая** — почти наверняка проблема в `getTgClient()`/`tg.for(...)` (нет залогиненной сессии для нужного `tgAccountId`). Проверь `TgAccount.status` в БД.
2. **`object_storage disabled` warning** — флаг не включён или Redis pub/sub не доходит до воркера. Рестарт воркера должен помочь.
3. **`Error: PUT https://... 403`** — S3 креды неверные / bucket не существует. `docker exec outreach-minio mc mb local/outreach-media`.
4. **`MediaAsset` строки не появляются вообще** — либо tg-listen не подписан (нет залогиненной сессии), либо media не дошло до handler'а. Проверь логи воркера на `tg-listen: subscribed`.
5. **Воркер падает на инбаунде** — это регрессия в `downloadInboundMediaWithClient` контракте. Прогнать `pnpm test --filter @nosquare/tg-client` — должны падать unit-тесты, дальше дебагать по логу.

## Как воспроизвести honest-pending path осознанно

Реальные ветки кода (`apps/workers/src/services/media-store.ts`):

- **`degraded: 'no_bytes'`** — `s3Key=''`. Возникает когда либо downloadBytes вернул null/пусто, либо `getObjectStore()` вернул null (флаг ON, но S3 не сконфигурирован).
- **`degraded: 'error'`** — outer try/catch поймал throw из любой части (например, `putObject` упал на сетевой ошибке). Строка `MediaAsset` может вообще не появиться (зависит от стадии).
- **Полный skip без записи** — флаг `object_storage` OFF. `persistInboundMedia` вообще не вызывается, MediaAsset не создаётся (см. `tg-listen.ts:201`).

Самый чистый способ воспроизвести `no_bytes`:

1. Воркеры подняты, флаг `object_storage` ON.
2. В `.env` **очистить** все `S3_*` переменные (`S3_ACCESS_KEY=`, `S3_SECRET_KEY=`, etc.) и перезапустить воркер. `loadStorageConfig()` вернёт неполный конфиг → `getObjectStore()` вернёт null.
3. Отправь медиа. В логах будет warn `inbound media: storage flag on but config absent; recorded metadata-only media_asset`. Строка в БД появится с `s3Key=''`, `bytes=<метаданные из TG>`, `sha256=null`.

Альтернатива (более грубо, но проще на dev):

- Включить `object_storage`, но в `.env` указать **рабочий** `S3_ENDPOINT`/`ACCESS_KEY`/`SECRET_KEY` и НЕсуществующий `S3_BUCKET`. Воркер стартует, `putObject` упадёт на 404 → catch вернёт `degraded: 'error'` (может не быть никакой строки в БД, в зависимости от стадии — см. media-store.ts). Это полезно проверить «защиту от exception», но не сам honest-pending row.

Чего НЕ делать для воспроизведения no_bytes:
- НЕ выключайте `object_storage` (в этом случае `persistInboundMedia` не вызовется вовсе, и MediaAsset не создастся, и smoke не проверит контракт).
- НЕ ломайте `TG_API_HASH` (это сломает всю сессию, не just media).

## Когда считать smoke пройденным

- ✅ Хотя бы один success path (`s3Key` непустая, файл доступен через presigned URL, sha256 ненулевая).
- ✅ Никаких unhandled-ошибок в воркер-логах.
- ✅ (Опционально, для усиления уверенности) honest-pending path воспроизведён управляемо — `s3Key=''`, в логе warn, диалог продолжает работать.
