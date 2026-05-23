## Context

Тонкое инфраструктурное изменение: тесты + runbook вокруг `downloadInboundMedia` плюс минимальный рефактор для тестируемости. Тело `downloadInboundMedia` (handle-метод, closure над `client`/`tgAccountId`) извлечено в экспортируемый чистый хелпер `downloadInboundMediaWithClient(client, tgAccountId, opts)`. Контракт (best-effort → null, никогда не throw) сохранён 1-в-1.

## Goals / Non-Goals

**Goals:**
- Закрыть гэп «нет тестов на downloadInboundMedia» детерминистическими unit-тестами против мока GramJS-клиента.
- Дать оператору воспроизводимый чеклист для live smoke'а, когда подключится реальный TG-аккаунт.

**Non-Goals:**
- Не переписывать `downloadInboundMedia`. Его контракт — best-effort (любая ошибка → null), и это сознательное решение.
- Не вводить mock-recording против реального TG (msw / nock против `getMessages`) — не оправдано для этой узкой обёртки.
- Не делать live smoke (требует залогиненной сессии, операторская задача).

## Decisions

### Decision 1: Извлечь чистый хелпер `downloadInboundMediaWithClient`, а не тестировать через `SessionManager`

**Что:** Тело handle-метода вынесено в экспортируемую функцию с узким интерфейсом `DownloadMediaClient { getMessages, downloadMedia? }`. Тесты импортируют функцию напрямую и мокают `getMessages` / `downloadMedia` через `vi.fn()`.

**Почему:**
- Тестировать через `SessionManager` потребовало бы поднимать GramJS dynamic-import (`telegram` пакет), мокать `TelegramClient`, `StringSession`, прокси, FloodGuard и SessionLoader. Цена ради 13 unit-тестов несопоставима.
- Хелпер чистый: closure-зависимостей нет (используется только `client` + `tgAccountId` для warn-лога). Извлечение тривиально и сохраняет 1-в-1 контракт.
- Существующие тесты tg-client (`RateLimiter.test.ts`, `classifyTgError.test.ts`) тоже тестируют чистые функции напрямую — это устоявшийся паттерн пакета.

### Decision 2: Контракт — best-effort null, без выбрасывания

**Что:** Каждый тест проверяет, что метод возвращает `Uint8Array | null` и НЕ выбрасывает, какие бы данные / ошибки ни пришли от GramJS.

**Почему:** Это и есть инвариант, на который опирается tg-listen worker (`downloadBytes` thunk → `null` → media-store пишет honest-pending). Если invariant сломается, инбаунд-обработка получит throw, и диалог может встать.

## Risks / Trade-offs

- **[Trade-off] Юнит-тесты против мока не ловят регрессии в реальной GramJS-семантике.** Принимаем — это страховка от внутренних регрессий, не от внешних. Live smoke остаётся обязательным шагом перед prod.
- **[Trade-off] RUNBOOK предполагает оператора с навыками работы с админкой/psql.** Принимаем — это и есть аудитория «оператор» в текущем дизайне.
