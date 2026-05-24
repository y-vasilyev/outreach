## Context

`OpeningComposer` и `AgencyOpeningComposer` сейчас возвращают 2–3 варианта первого сообщения, оба воркера (`campaign-dispatcher.ts` и `agent-run.ts handleOutreachFirstMessage`) прогоняют каждый вариант через `SafetyFilter`, для safe-вариантов создают `Suggestion(agentName='opening_composer')` и выбирают «best by safety score» для auto-send. В этой схеме теряется ассоциация «какой вариант был выбран → пошёл в Message → получили ли ответ»:

- `Suggestion.meta` пустой (`{}`).
- `Message` не помнит, какой именно вариант был отправлен; даже agentName на `Message` нет.
- Оператор может посмотреть тексты в инбоксе, но статистики reply rate per «вариант» нет.

Сторонние шаги уже на месте: `Suggestion.meta` — `Json @default("{}")`, последовательность `Suggestion → Message` (linked through `suggestionId`) уже надёжная, `Message.suggestionId` опциональный. Это даёт минимально-инвазивный путь: добавить одно поле в LLM output, протащить через мету suggestion-а в новую колонку message-а, и одним SQL-запросом построить отчёт.

## Goals / Non-Goals

**Goals:**
- Стабильный `variantKey` идентификатор для каждого варианта опенера, прокидываемый от composer → suggestion → message.
- Read-only endpoint `GET /campaigns/:id/opener-stats` с агрегатами sent/replied/replyRate per variantKey.
- Обратная совместимость: миграция nullable, всё работает на старых сообщениях (просто без атрибуции).
- Минимум новых концепций: никакого `Experiment`, `Trial`, `Allocation` модели.

**Non-Goals:**
- Статистическая значимость, p-value, sample-size calculators.
- Автоматическое отключение «проигравших» вариантов.
- Bandit / Thompson-sampling алгоритмы выбора варианта на отправке (selection остаётся «best by safety score», как сейчас).
- UI для просмотра статистики — фронт-эндпоинт чистый, но виджет в админке — отдельный follow-up.
- Атрибуция inbound к конкретному outbound (ниже см. Decision 2).

## Decisions

### Decision 1: `variantKey` источник — детерминированный пост-процесс с LLM-override

**Выбор**: LLM может опционально вернуть `variant_key` в каждом варианте; если не вернул (или дубликат), детерминированный пост-процесс присваивает `A`, `B`, `C…` по индексу. Маршрут «всегда A/B/C» проще, но теряет семантику кастомных промптов, в которых оператор хочет назвать варианты осмысленно (`concise` / `value_prop`). Маршрут «только LLM» хрупкий: если LLM забыл поле — нет статистики.

**Альтернативы:**
- `variantKey = hash(text).slice(0,8)` — стабильный относительно текста, но при rerun на тот же канал даст разные значения (текст немного меняется), что делает агрегацию шумной.
- `variantKey = индекс варианта в массиве` (просто int) — теряет читаемость в отчётах.

**Правила пост-процесса** (детерминированные, выполняются после LLM-валидации):
1. Если LLM вернул `variant_key` непустой и непустой строки — нормализуем (`trim`, lowercase для алфавитных коротких ключей сохраняем как есть, обрезаем до 32 символов).
2. Если ключ дублируется внутри одного ответа — суффикс `_2`, `_3`, …
3. Если LLM не вернул ключ — `'A'`, `'B'`, `'C'`, … по индексу.
4. После пост-процесса ключи уникальны внутри одного composer-run.

### Decision 2: `replied` метрика — простой "any inbound within window after outbound"

**Выбор**: `replied = (∃ Message m WHERE m.conversationId = opener.conversationId AND m.direction = 'in_' AND m.createdAt BETWEEN opener.sentAt AND opener.sentAt + withinHours)`. Один conversation = один opener (мы создаём opener только когда у conversation ноль сообщений), так что мисс-атрибуции на этом этапе нет.

**Альтернатива:** «первый inbound после opener — это reply, attribut'ить ему именно opener, последующие inbound — на reply_composer-сообщения». Усложняет SQL и не даёт лучшего сигнала: для opener-stats нам нужен факт «получили хоть какой-то ответ в окне».

**`withinHours`** — параметр запроса, дефолт 48, диапазон 1..720 (30 дней). Меньше суток — для нетерпеливых оптимизаций, больше месяца — статистика про конверсию в долгие воронки.

### Decision 3: `Message.openerVariant` колонка vs. join через `Suggestion.meta`

**Выбор**: добавить `Message.openerVariant String?`. Альтернатива — каждый раз джойнить `Message → Suggestion`, читать `meta->>'openerVariant'`. Минусы джойна: (а) `Message.suggestionId` опциональный (для legacy / оператор-edit без suggestion), (б) JSON-extract по `meta` без индекса — sequential scan, (в) аналитический запрос будет неприлично уродливый.

Колонка nullable, индекс `(conversationId, openerVariant)` помогает stats-запросу. Для не-opener-сообщений (replies, operator-edits) `null` — отсутствие variant ≠ другой бакет.

### Decision 4: Выбор варианта на отправке остаётся «best by safety score»

**Не меняем** существующую логику выбора варианта (`bestScore = max(1 - safety.risk_score)`). Альтернатива — round-robin или weighted-random — превращает фичу в полноценную experiment-инфраструктуру (нужна detrministic allocation, traffic split, контроль над dupe runs), что выходит за scope. Безопасно-смещённый сэмплинг — следствие. Когда оператор сам редактирует промпт и заставляет LLM писать варианты примерно равной безопасности — selection становится случайным (LLM сам разнообразит). Если в будущем понадобится истинный random split — отдельный change.

### Decision 5: Стат-эндпоинт включает edited/sent статусы — не включает rejected/expired

**Выбор**: `sent` = количество `Message` с `openerVariant=K`, `status='sent'` (т.е. реально ушедших в TG). `replied` — как в Decision 2. Suggestion'ы со статусом `rejected`/`expired` не идут в знаменатель — они не дошли до отправки и не дают сигнала о конверсии.

Альтернатива «sent = все suggestion'ы с этим вариантом, отправленные хоть как-то (auto/operator/edited)» — даёт тот же результат, потому что `tryAutoApprove` и `approveSuggestion` оба создают `Message` с `openerVariant` (см. Decision 3), и `status` доезжает до `sent` только после успешной отправки tg-send-воркером.

### Decision 6: Где живёт сервис — `apps/api/src/services/opener-stats.ts`

Стат-логика — read-only агрегация двух таблиц и одного фильтра по времени, никакого LLM, никакого общего состояния с воркерами. Сидит рядом с `campaigns.ts`, но в отдельном файле, чтобы не разрастать монолит campaigns-сервиса.

## Risks / Trade-offs

- **[Risk] LLM может проигнорировать `variant_key`** в самом валидаторе → пост-процесс детерминированно проставит `A/B/C…`. **Mitigation**: оба пути имплементированы и unit-тестируются.
- **[Risk] Изменение промпта без bump'a версии композера смешает старую и новую статистику под одними ключами `A/B`.** **Mitigation**: документировано в proposal.md; stats endpoint оперирует «как есть», следующий change может добавить `agent_config_version` к meta.
- **[Risk] Replied-окно не различает inbound на opener vs inbound на reply.** На опенер-стейдже это нечастый кейс (мы считаем reply только в окне сразу после opener), но не нулевой. **Mitigation**: документировано (Decision 2). Если шум станет значимым — добавим фильтр «нет outbound между opener и inbound».
- **[Risk] Race на `Suggestion.meta` если несколько композеров пишут в одну conversation.** **Mitigation**: текущий dispatcher отказывается генерить opener, если у conversation уже есть `existingOpeningSuggestions` — гонки не существует by construction (см. `campaign-dispatcher.ts:247`).
- **[Trade-off] Колонка `Message.openerVariant` для всех сообщений, даже не-opener.** Простота и индексируемость важнее экономии байтов NULL. Альтернатива — отдельная таблица `message_opener_variant` — overkill.

## Migration Plan

1. PR с migration + composer изменения + сервис + route + тесты.
2. `pnpm db:migrate:deploy` в проде — добавляет nullable колонку и индекс. Обратносовместимо: старые message-ы получают `null`.
3. Рестарт API + workers. С момента рестарта новые opener-suggestion'ы носят `meta.openerVariant`, новые `Message` — `openerVariant`.
4. Стат-эндпоинт сразу работает: для старых данных вернёт пустой массив (нет ни одного `openerVariant != null`), для новых будет наполняться.
5. Rollback: дроп колонки = lossy (теряем атрибуцию). Безопасный частичный откат — оставить колонку, откатить только composer-изменения и сервис.

## Open Questions

Нет — scope зафиксирован, все решения приняты в Decisions 1–6.
