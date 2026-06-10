# Changelog

All operator-visible changes worth noting between releases.

## Unreleased

### Added

- **Серверные фильтры каталога блогеров.** Главный запрос оператора теперь
  выполняется базой данных: «телеграм-посты до 50 000 ₽ (или CPM до X),
  свежее N дней» — новые контролы в каталоге (тип размещения, «Цена до, ₽»,
  «CPM до, ₽», «Свежее, дн.») и сортировки «цена ↑» / «CPM ↑» по лучшему
  подходящему офферу. Устаревшие прайсы (старше 90 дней) помечаются
  «устарело», но не скрываются. Подбор по брифу с бюджетом стал быстрее за
  счёт SQL-предотбора кандидатов — результаты подбора не меняются
  (гарантия суперсета закреплена тестами).

- **Сравнение прайсов в рублях + CPM.** Прайсы блогеров в валюте теперь
  сравниваются честно: админ задаёт курсы в Настройки → Курсы валют, и
  долларовые/евровые офферы получают ₽-значение (с пометкой «по курсу от
  даты»); подбор по бюджету считает в рублях, а не сравнивает сырые числа.
  У офферов появился CPM (₽ за 1000 просмотров, по медиане просмотров постов
  платформы; «≈» — оценка по средним просмотрам профиля) — виден в карточке
  и в сигналах подбора. Цены-диапазоны больше не теряются: «от 118 000»,
  «до 30к», «5-7к» сохраняются как вилка и показываются как вилка. Для уже
  собранных офферов: `pnpm db:renormalize:offers` после деплоя миграции `9g`.

- **История цен блогера в API профиля.** Прайсы теперь живут отдельными
  строками с жизненным циклом: новая цена того же размещения не затирает
  старую, а помечает её заменённой — `GET /blogger-profiles/:id` отдаёт
  `offerHistory` (актуальный оффер + прежние цены с датами). Переанализ
  сообщения оператором больше не уничтожает прежнее поколение офферов (видно,
  что изменилось). Сырой текст цены («от 118 000», «50к») сохраняется на
  строке как есть. Для существующих данных есть бэкфилл `pnpm
  db:backfill:offers` (запускать после деплоя миграции `9f`).

- **Инбокс: фильтр по направлению переписки + «Показать ещё».** В панели
  фильтров над списком появился выбор «Переписка»: «Я написал» (есть исходящее),
  «Ещё не написал» (исходящих нет) и «Мне ответили» (есть входящее). Все контролы
  фильтров теперь подписаны (Кампания / Переписка / Статус / Режим / Поиск), а
  быстрые чипы над списком получили текстовые метки. Панель фильтров сворачивается
  (кнопка «Фильтры» с счётчиком активных; состояние запоминается) — чтобы не
  занимать место. Список больше не обрывается молча на 100 диалогах — внизу
  кнопка «Показать ещё» подгружает следующую сотню (растущее окно, без скачков
  порядка при живом обновлении).

- **Карточка блогера «кто это» + операторские контролы в UI.** В инбоксе у
  каждого входящего — бейдж статуса извлечения и кнопка «Переанализировать»
  (живое обновление по веб-сокету); у вложений — чип OCR. В профиле: аудитория
  ПО ПЛАТФОРМАМ, удаление/правка точек данных, форма подсказки агенту, и
  галерея примеров постов с картинками (S3Image, фоллбэк-плейсхолдер).
  В каталоге — поиск по имени/теме/нику и сравнение 2–4 блогеров бок-о-бок
  (аудитория/прайс/форматы). YouTube-превью поста берётся по video id, картинки
  постов Telegram скачиваются публичным TG-парсером и сохраняются в S3 при
  обновлении постов.

- **Подготовка карточки блогера «кто это» (бэкенд-срез).** Схема постов получила
  поля картинки (`image_s3_key`/`image_status`, миграция 9e) под примеры постов;
  `ObjectStore.headObject` для проверки наличия объекта; статус OCR вложения
  теперь доходит до инбокса, а событие смены статуса извлечения — в веб-сокет;
  операторские роуты (переанализ/правка/подсказки) закрыты фичефлагом
  `agency_sourcing`. Полный UI (галерея постов, сравнение, кнопки оператора) и
  публичный TG-загрузчик картинок постов — следующий шаг (план в OpenSpec).

- **Прайсы и охваты из картинок-вложений теперь попадают в каталог (бэкенд).**
  Если блогер прислал прайс/медиакит/скриншот статистики картинкой, система
  распознаёт текст (vision-OCR через OpenRouter) и подаёт его в извлечение —
  раньше такой ответ давал ноль данных. Результат OCR кэшируется на вложении
  (одно распознавание на картинку), за флагом `attachment_ocr` (нужен
  `object_storage`). PDF пока помечаются как «не поддерживается». Base64-байты
  не сохраняются в `agent_run`.
- **Анализ ответов теперь виден, перезапускаем, правим и обучаем (бэкенд).** У
  каждого входящего сообщения появился статус извлечения (получено / пусто / нет
  сигнала / ошибка). Оператор может перезапустить анализ одного сообщения —
  старые строки заменяются (а не копятся). Можно вручную исправить или удалить
  поле профиля (правка оператора побеждает машинную). И можно создать
  «подсказку» для канала/диалога — агенты учтут её при следующем анализе
  (например, «МАХ — это мессенджер MAX»). API + воркер готовы; UI-кнопки
  появятся в следующем изменении каталога.

### Changed

- **Каталог стал сравнимым между блогерами по новым полям.** Появилась
  аудитория ПО ПЛАТФОРМАМ (Инст/ТГ/ВК/ТикТок отдельно, а не одно общее число),
  и у размещений — типизированные поля: название тарифа и слот, период цены
  (базовая/сезонная/акция), предоплата, налоговый режим (ИП/самозанятый/ООО) и
  «налог включён», часы в топе, состав пакета. Подбор под бриф умеет ранжировать
  по аудитории нужной платформы и берёт базовую цену для бюджета (а не временную
  сезонную). Разные слоты одного тарифа больше не схлопываются.
- **Каталог блогеров теперь надёжнее извлекает условия из свободных ответов и
  больше ничего «не теряет по дороге».** Структурированные размещения
  (`placementOffers`) пишутся ВСЕГДА (не за флагом) — флаг
  `structured_placement_offers` теперь влияет только на предпочтение при
  матчинге/планнере. Парсер ответов понимает больше форматов: множитель
  `млн`/`млрд`, разделитель тысяч точкой («12.000» → 12000), площадки МАХ и
  Дзен, пары «Фото-пост 120000, Видео-пост 170000» в одной строке, лесенки
  «час топа / 24ч / 72ч / месяц», цена «за ролик», и несколько налогов на одном
  размещении. Один битый элемент в ответе модели больше не отбрасывает все
  факты сообщения. Слишком неуверенные размещения (confidence < 0.2) не
  засоряют каталог для сравнения, но сохраняются как сырьё для проверки.

### Fixed

- **Альбомы постов больше не дублируют топ-посты, подпись берётся с корневого
  поста.** Пост-альбом (несколько фото) в Telegram — это N сообщений с общим
  `grouped_id`; раньше каждое фото становилось отдельным «топ-постом» (карточка
  на каждую картинку), а подпись была только у одного и терялась. Теперь альбом
  схлопывается в один пост (id — якорь альбома = ссылка `t.me/<handle>/<id>`,
  текст — реальная подпись, метрики — максимум по фото, без задвоения). Уже
  накопленные дубли-«остатки» альбомов вычищаются при следующем обновлении
  постов (в пределах свежего окна; старая история не трогается). Пример:
  `t.me/polyaam/25518`.

- **Карточка блогера снова прокручивается; топ-посты стали читаемыми
  карточками.** Профиль блогера не имел собственного скролл-контейнера, и при
  длинном содержимом нижние секции (прайс, аудитория, точки данных) обрезались
  под фиксированной высотой страницы — теперь контент прокручивается. Топ-посты
  переехали из плотного списка с мелкой моно-типографикой в сетку карточек:
  превью поста, бейдж свежести метрик, и сами метрики (просмотры/лайки/реакции/…)
  отдельными плитками вместо одной строки.

- **Извлечение прайса из ответов блогера перестало срываться (диалоги уходили в
  `assisted`).** `rate_card_extractor` теперь возвращает три представления сразу
  (структурированные размещения + предложения атрибутов + легаси-точки), и для
  прайса с несколькими форматами ответ модели не помещался в лимит токенов —
  JSON обрывался на полуслове (`unbalanced JSON`), весь профиль-экстракт падал,
  и диалог деградировал в ручной режим. Подняли бюджет токенов агента, а общий
  repair-loop при обрыве по токенам теперь повторяет запрос с увеличенным
  лимитом (раньше переотправлял тот же обрезанный ответ с тем же лимитом —
  гарантированно снова обрыв). Чтобы новый лимит дошёл до прода, нужен
  `pnpm db:seed`.

- **«Запустить в работу» больше не пишет владельцу канала вдобавок к менеджеру
  по рекламе.** Когда у канала опубликован и явный рекламный контакт
  («Реклама/сотр-во: @manager», `ad_manager`), и личный аккаунт владельца
  («Мама Оля https://t.me/…», `owner`), запуск создавал по чату на каждый — то
  есть ДМ уходил и в личку владельца. Теперь launch-into-work выбирает один
  лучший контакт на канал (та же приоритизация, что у автодиспетчера:
  `ad_manager` ≻ `owner`), а на личный контакт владельца переходит только когда
  рекламного контакта нет.

### Added

- **Discovery: честный статус разбора, рабочая кнопка scrape и «Запустить в
  работу».** Направляемый поиск больше не показывает зелёный `done`, пока
  кандидаты ещё не разобраны: для свежей ниши запуск переходит в новый
  нетерминальный статус `enriching` со счётчиком «ожидают разбора: N», и
  кандидаты получают evidence-обоснованную рекомендацию по мере того, как
  доезжают их scrape'ы (раньше для новой ниши «Разобрано» всегда было 0, а
  сохранялись хендлы без доказательств). Кнопка «Обновить scrape» теперь
  действительно ПЕРЕ-СКОРИТ кандидата после повторного скрейпа (была тупиком —
  score/рекомендация залипали навсегда). Запуск гарантированно завершается даже
  если scrape не пришёл (есть ограниченный по времени fallback). Новое действие
  «Запустить в работу» на сохранённом/шортлистнутом кандидате с привязанным
  каналом: оно ПЕРЕИСПОЛЬЗУЕТ существующий путь добавления контактов в кампанию
  и готовит **черновик** первого сообщения как pending-предложение под
  подтверждение оператора — НИКОГДА не отправляет автоматически. Берутся только
  явно опубликованные рекламные/business-контакты (`ad_manager`/`owner`); для
  agency-кампаний нужен включённый флаг `agency_sourcing`. Всё за флагом
  `channel_discovery`.

- **AJTBD-направляемый поиск блогеров (Discovery workbench).** Вкладка Discovery
  из «ниша → сырые хендлы» превращается в рабочий стол: оператор выбирает
  кампанию (её цель/AJTBD) или вводит ручной бриф, а система сама строит план
  веб-поиска, выполняет запросы через Yandex Search, нормализует кандидатов,
  заводит/переиспользует каналы (ставит scrape для новых) и оценивает каждого
  кандидата на соответствие брифу. По каждому запуску виден прозрачный лог
  (план запросов, что искали, сколько нашли, ошибки по запросам, разбор), а
  кандидаты приходят карточками с fit-рекомендацией (`strong/possible/weak/
  reject`), score, рисками и доказательными постами (snippet + «почему
  подошёл»). Кандидата можно сохранить/в шортлист/отклонить, обновить scrape и
  открыть канал/профиль. Два новых сид-агента (`discovery_query_planner`,
  `blogger_discovery_reviewer`), асинхронный воркер `guided-discovery`, бюджеты
  на запросы/результаты/кандидатов/разбор, новые таблицы `discovery_run` и
  `discovery_run_candidate` (миграция `8_guided_discovery_runs`), эндпоинты
  `POST/GET /discovery/guided`, `GET /discovery/guided/:id` и действия по
  кандидату — всё за флагом `channel_discovery`. Только публичные страницы/
  посты, без авто-отправки сообщений. Низкоуровневый одиночный/batch-поиск
  остаётся доступен как отладочная секция.

- **Архивирование и удаление чатов в инбоксе.** Нецелевой («нецелевка»)
  диалог теперь можно убрать из рабочего инбокса: в меню «…» открытого чата —
  «В архив (нецелевка)» (обратимо, статус `archived`) и «Удалить чат»
  (безвозвратно, под confirm). Архивные чаты по умолчанию скрыты из списка и
  доступны через фильтр статуса «Архив»; «Вернуть из архива» возвращает в
  работу. Удаление сносит диалог, его сообщения и pending-подсказки; `agent_run`
  сохраняются (учёт стоимости LLM не теряется). Новый статус
  `ConversationStatus.archived` (миграция `7_add_conversation_archived_status`,
  чистый additive `ADD VALUE`), эндпоинты `PATCH /conversations/:id`
  (`status: archived`) и `DELETE /conversations/:id` (admin/operator),
  realtime-событие `conversation.deleted`.

- **«Убрать дубли» в инбоксе.** Кнопка над списком диалогов (admin/operator)
  схлопывает дублирующиеся диалоги по каналам: на канал остаётся один тред.
  Чаты, где уже была переписка (входящие ИЛИ исходящие), всегда сохраняются —
  «если я уже кому-то написал, оставляем этот чат». Удаляются только пустые
  дубликаты, по которым ещё никто не писал; если на канале пусто во всех, по
  приоритету роли остаётся лучший контакт (`ad_manager` > `owner` > `generic` >
  …). Холодные лиды без канала не трогаются. Удаление пустых тредов безопасно
  для учёта: `agent_run` сохраняются (ссылка обнуляется), теряются только
  эфемерные pending-подсказки опенинга. Эндпоинт `POST /conversations/dedupe`.

- **`bot` contact type** (openspec change `add-bot-contact-type`). Some bloggers
  publish only an advertising bot as their business contact (e.g. «по рекламе —
  @hadeout_bot»). These are now captured as a first-class `bot` contact type
  instead of being dropped or mislabeled as a plain username. The extractor
  classifies a `*_bot` handle as `bot` only when the surrounding text shows it's
  an ad/intake channel; service bots without ad context are still ignored. Bot
  contacts are TG-reachable and show a distinct icon in the contacts list, with
  `bot` available in the type filter, create dialog, and edit drawer. They are
  deliberately **excluded from automated campaign dispatch** — an ad bot expects
  a /start/menu flow, not a human-framed opener — so operators reach them
  manually from the inbox.

- **Structured placement offers** (openspec change `entity-style-rate-cards`).
  Blogger quotes are now extracted as structured commercial offers — each with
  a stable `kind` plus typed attributes (platform, duration, deletion policy,
  included deliverables, tax, notes), confidence, and source provenance —
  instead of only flat `rate.<format>` price points. A day post and a month
  post no longer collapse into one price; tax (e.g. «налог 6%») is kept as an
  attribute rather than a phantom price row. The blogger profile page renders a
  new "Размещения" card showing each offer's terms with its raw source snippet;
  the legacy price table remains as a fallback. The data-collection planner now
  asks focused follow-ups for missing terms (deletion policy, duration, tax,
  deliverables) instead of re-asking for the whole rate card, and blogger
  matching can rank on structured terms (e.g. a long-lived Telegram post over a
  one-day post). Extraction may propose new attributes it sees in real quotes;
  proposals stay inactive until an admin approves them under a new
  **Settings → admin** review surface (`/placement-attributes`). Everything is
  gated by the new **`structured_placement_offers`** feature flag
  (Settings → Features, admin-only, default off) with a legacy-only fallback;
  legacy `rateCards`/`formats` stay populated (derived from offers) during
  rollout. Ships a DB migration (`blogger_profile.placement_offers` column +
  `placement_attribute` registry/proposals table).

### Fixed

- **Campaign dispatch writes to the channel's ad/manager contact, not its
  owner.** When a channel published both an explicit advertising contact
  («Сотрудничество: менеджер @leksamng», `ad_manager`) and a general owner /
  «По вопросам» contact (`owner`), the dispatcher could open the conversation
  with the owner — it ranked candidates by `confidence` alone, so a
  higher-confidence owner outran the manager, and with no per-channel dedup it
  even messaged both. The dispatcher now keeps at most one contact per channel
  and picks the best by role first (`ad_manager` > `owner` > `generic` > `bot`
  > `unknown`), then type, then confidence — matching `ContactPrioritizer`. A
  contact an operator explicitly dropped into the campaign («В кампанию») still
  wins within its channel. Cold-lead contacts (no channel) are unaffected.

- **Production console errors — realtime restored & noise removed**
  (openspec change `fix-prod-console-errors`). Three production-only
  defects fixed: (1) the inbox WebSocket (`wss://outreach.su/socket.io/`)
  failed in an endless reconnect loop — the k8s Ingress applied its
  `/api`-prefix `rewrite-target` to every path, stripping `/socket.io`
  to `/`; socket.io now lives in its own annotation-free Ingress object so
  realtime (live messages, suggestions, status, HUD updates) works again.
  (2) Lazy-loaded pages (e.g. Контакты) could fail after a redeploy with a
  misleading `text/html` MIME error — the static server now returns a real
  404 for a missing hashed chunk instead of the SPA shell, and the web app
  reloads once to pull the fresh bundle. (3) The inbox no longer spams
  per-conversation `data-collection` 404s while `data_collection_hud` is
  off — the public `/config` snapshot now exposes the flag and the panel
  skips the request entirely when it is off.

### Added

- **Inbox — data-collection HUD (behind `data_collection_hud` flag)** —
  a new right-panel section in the conversation view for `agency_sourcing`
  campaigns shows per-target state (`answered` / `asked` / `missing` /
  `stale`) live: which commercial data points the bot has already
  captured, which it asked about with no answer yet, and which contributing
  facts have gone past their freshness TTL. Each row carries a source
  link that scrolls the inbox to the originating message, a freshness
  pill, and a "Задать вопрос" shortcut on `missing`/`stale` rows that
  pre-fills the composer from the field's operator description. Backed
  by the new typed target-field registry in `packages/shared/src/
  data-collection-targets.ts` — single source of truth shared by the
  planner, the HUD, and the gate prompt. Default OFF; flip
  `data_collection_hud` from Settings → Features once the feature is
  validated in staging. See openspec change
  `data-collection-hud-target-fields`.

- **Agency sourcing — sponsored-integration detector** — a new
  LLM-classifier agent (`sponsored_integration_detector`) is now the
  ONLY source for `observed_integrations` fed into the agency opener
  composer. Last-N posts are no longer passed through as candidate
  integrations, so the opener cannot accidentally cite a non-sponsored
  post as «вашу интеграцию с …». If the detector finds nothing (or
  fails), the opener falls back to a generic-topic hook and the
  composer's no-fabrication guard keeps the variant non-eligible for
  auto-send. See openspec change `harden-agency-sourcing-pipeline`.

### Changed

- **Agency opener — `auto_send_eligible` is enforced** — variants the
  composer marks as not eligible (typically agency variants without a
  real sponsored integration to cite) are saved as `pending`
  Suggestions for operator review but never auto-approved, regardless
  of safety score. CustDev openers are unaffected (they don't emit
  the field). See `harden-agency-sourcing-pipeline`.

- **Full campaign-type safety profile on every outbound** —
  dispatcher, on_inbound reply, first-message opener, operator
  approve, and direct send now all go through a single
  `buildSafetyInput` helper that feeds SafetyFilter the FULL profile
  (allowed/forbidden topics, hard blocks, max_length, allow_links)
  resolved from `campaign.type.safetyProfile`. Previously some sites
  passed only `hard_block_patterns` and operator approve/direct send
  passed no profile at all. See `harden-agency-sourcing-pipeline`.

- **Agency inbound: synchronous profile extraction** — for
  `agency_sourcing` conversations the inbound pipeline now runs
  `handleProfileExtract` synchronously before invoking the
  DataCollectionPlanner, so the planner sees facts in THIS inbound and
  no longer re-asks for the price the blogger just shared. Cheap
  deterministic pre-gate skips extractor calls on turns with no
  commercial signal at all (e.g. "ок, в пятницу"). Media-kit assets
  attached before the catalog profile existed are now back-filled with
  `profileId` in the same transaction. Double-failure throws so the
  BullMQ retry kicks in (was silently swallowed). See
  `harden-agency-sourcing-pipeline`.

- **Agency goal-fit gate is campaign-type aware** — `GoalFitEvaluator`
  now branches its non-goals by campaign type: CustDev keeps the
  research-interview framing, `agency_sourcing` flags premature money
  commitments / fabricated client details / result guarantees. The
  AJTBD scaffold built for agency campaigns lifts
  `goal.target_data_points` into `desired_outcome`. See
  `harden-agency-sourcing-pipeline`.

- **Operator UX — agency campaign created with the flag off rejects
  fast** — campaign create/update now responds 422
  `AGENCY_SOURCING_DISABLED` instead of silently routing the campaign
  through the CustDev opener. Existing agency campaigns under a
  flag-off rollout emit a warn-log per dispatcher tick / inbound run
  and skip the agency-specific branches. See
  `harden-agency-sourcing-pipeline`.

- **Smaller agency planner fixes**: `deals_contact` removed from the
  default target set (no extractor yet — caused infinite re-asking);
  `audience_demographics` and `geo` are now distinct collected
  targets so capturing only geo no longer hides demographics from the
  planner; `client_brief` is read from `goal.client_brief` (with
  `valueProp` legacy fallback) and reaches the opener; opener
  deduplication in `addContacts` recognises both `opening_composer`
  and `agency_opening_composer`; `RateCardExtractor` no longer blindly
  prepends `rate.` to whatever the LLM returns (`reach.story` is
  dropped, not stored as `rate.reach.story`).

### Added

- **Inbox: per-campaign filter and friends** — the inbox now exposes a
  filter bar with campaign / status / mode dropdowns and a debounced
  contact/channel text search. State lives in the URL, so reloads and
  shared links restore the same view; user-initiated changes use
  `router.push` (back/forward navigates between filter states), while
  auto-selecting the first conversation uses `router.replace` so it
  doesn't pollute history. The campaign detail page now has an "Инбокс
  кампании" action that deep-links into `/inbox?campaignId=<id>`.
  `assignedOperatorId` is honoured via deep-link (no UI picker yet —
  `GET /users` is admin-only and the inbox is shared with operators /
  viewers; a role-safe lookup will come in a follow-up change). The
  shared `ConversationFiltersZ` schema gained empty/whitespace
  normalisation for enum/id fields and a `q.max(200)` cap to keep the
  downstream `ILIKE` scan bounded. See openspec change
  `inbox-campaign-filter`.

### Changed

- **`downloadInboundMedia` is now unit-tested** — the tg-client method
  that backs the inbound media-asset pipeline was previously covered only
  indirectly via the `mediaStore` tests in workers. Extracted the core
  logic into the exported helper `downloadInboundMediaWithClient` (pure,
  takes a minimal `DownloadMediaClient` shape) and added 13 unit tests
  covering every branch of the contract (invalid msgId, no message, no
  media, missing `downloadMedia`, throws, null/string/Uint8Array/Buffer/
  unsupported returns, correct `getMessages` argument shape, never
  throws). Behavior is unchanged. A `RUNBOOK.md` in the archived
  openspec change documents the live-smoke procedure operators run
  before flipping `object_storage` on in prod. See openspec change
  `verify-download-inbound-media`.

### Added

- **A/B opener variants** — the opener composers
  (`opening_composer` and `agency_opening_composer`) now stamp each
  variant with a stable `variantKey` (LLM can supply a semantic key
  like `'concise'` / `'with_brand'`; otherwise a deterministic
  post-process assigns `'A'`, `'B'`, `'C'`, …). The key flows through
  `Suggestion.meta.openerVariant` into the new `Message.openerVariant`
  column, both on the auto-send path (`tryAutoApprove`) and the
  operator-approve path (`approveSuggestion`). A new read-only
  `GET /campaigns/:id/opener-stats?withinHours=<H>` endpoint returns
  per-variant `{ variantKey, sent, replied, replyRate }` rows (default
  `withinHours=48`, capped at 30 days). No feature flag — purely
  additive observability layered on top of the existing opener flow.
  See openspec change `ab-opener-variants`.

- **Batch channel discovery** — operators can submit up to 50 niches at
  once via `POST /discovery/batch` and poll progress through
  `GET /discovery/batch/:id`. A `DiscoveryBatch` row tracks the request,
  the new `discovery-batch` worker iterates the niches sequentially
  (concurrency 1 + a 1-second rate-limit pause between calls) and
  pushes new channels through the existing `channel-scrape` →
  `contact-extract` intake. Per-niche failures are recorded in the
  batch summary and don't abort the run; the operator sees exactly
  which niches succeeded vs errored. Behind the `channel_discovery`
  runtime flag like single-niche discovery. See openspec change
  `batch-channel-discovery`.

- **SafetyFilter deterministic hard-block** — campaign-type
  `safetyProfile` gains a `hard_block_patterns` list of regex rules with
  ids and human-readable reasons. SafetyFilter evaluates them BEFORE the
  LLM scoring step; any match forces `allow=false`, `risk_score=1`, and
  a structured `reason` line. The LLM stays advisory. The
  `agency_sourcing` seed ships with six patterns covering result
  guarantees (verbal/adjective/numeric/English forms), time-pressure
  tactics, and pre-operator payment mentions;
  CustDev gets an explicit empty list (legacy advisory-only behavior).
  Malformed patterns are skipped without crashing the pipeline. See
  openspec change `safety-filter-hard-block`.

### Removed

- **`Campaign.ajtbd` column** — the legacy JSON column was a parallel
  storage to `Campaign.goal`; for `custdev` campaigns it carried the
  same AJTBD payload, for `agency_sourcing` it held a synthetic
  scaffold nobody edited. Runtime consumers (`HandoffDecider`,
  `ReplyComposer`, `GoalFitEvaluator`, the worker `agent-run.ts`, web
  `CampaignForm.vue`, the campaigns service) now read the AJTBD view
  from `Campaign.goal` via a new pure helper
  `extractAjtbdView({ goal, goalText, valueProp })` exported from
  `@nosquare/shared` — passthrough when goal carries the AJTBD-shape
  (CustDev), scaffold from `goalText` + `valueProp` otherwise. Two
  migrations land together: `9b_backfill_campaign_goal_from_ajtbd`
  copies any unset `goal` from `ajtbd`, then
  `9c_drop_campaign_ajtbd` removes the column. API request/response
  schemas (`CampaignZ`, `CreateCampaignInputZ`, `UpdateCampaignInputZ`)
  no longer accept or return `ajtbd`. No behavior change for agents —
  they still consume an AJTBD input contract. See openspec change
  `drop-campaign-ajtbd-column`.

- **`packages/shared/src/flags.ts`** — the "compile-time" flags module
  (`ENABLE_LLM_CONTACT_EXTRACTION`, `ENABLE_AUTO_MODE`,
  `ENABLE_FOLLOWUP_CRON`, `ENABLE_QUALITY_REVIEW`,
  `MAX_DRY_RUN_TOKENS`, `DEFAULT_DAILY_MSG_LIMIT`,
  `DEFAULT_DAILY_NEW_CONTACT_LIMIT`, `WARMUP_STAGES`, and the
  derived `FeatureFlag` type) had no consumers anywhere in
  `packages/` or `apps/` — neither static imports nor dynamic
  `flags['…']` access. Deleted along with its `index.ts` re-export.
  All operational toggles in the system are now runtime flags
  (`feature_flag` table + admin UI). No behavior change. See
  openspec change `remove-dead-flags-ts`.

### Fixed

- **`prisma migrate deploy` on a fresh Postgres cluster** — the
  `4_chat_autonomous_modes` migration previously combined
  `ALTER TYPE "ConversationMode" ADD VALUE 'semi_auto'` with `UPDATE`
  statements that referenced the freshly-added enum value in the same
  transaction; Postgres rejects that with `unsafe use of new value
  'semi_auto' of enum type ConversationMode`, so any clean prod
  deploy failed. The backfill is now split into a separate
  `9a_chat_modes_backfill_semi_auto` migration, which runs after
  migration 4 commits and is idempotent on a clean cluster. No
  user-facing behaviour change; legacy `mode='auto'` /
  `defaultMode='auto'` rows are still backfilled to `semi_auto`,
  just in a separate transaction. See openspec change
  `fix-migration-4-enum-tx`.

### Added

- **Channel discovery via web search** — find candidate blogger channels by
  niche through the Yandex Search API and queue them straight into the existing
  scrape → contact-extract intake (`POST /discovery/search`, admin/operator).
  Results are normalized to platform handles (telegram/instagram/youtube),
  de-duplicated, and only genuinely new channels are created + scraped. Behind
  the `channel_discovery` runtime flag (default off); the Search key is stored
  encrypted as a `yandex_search` integration.

- **Runtime feature flags** — operational rollout/kill-switch flags
  (`campaign_types`, `agency_sourcing`, `object_storage`, `blogger_matching`)
  moved from compile-time constants into the DB, toggleable from a new
  admin-only **Settings → Features** page without a redeploy. Flips take
  effect in the API and workers immediately (Redis pub/sub), give operators
  an instant kill-switch for risky outreach, are audited, and show readiness
  hints (e.g. "S3 not configured"). An emergency env override
  (`FEATURE_<KEY>_FORCE`) can pin a flag during incidents. Defaults are all
  off, so behavior is unchanged until a flag is turned on.

- **Campaign types (agency sourcing & matching)** — campaign goal/framing/
  safety/agent-set moved out of hardcoded CustDev into a configurable
  `campaign_type` registry. CustDev is now the seeded `custdev` type; a new
  `agency_sourcing` type poses as a media-buying agency to collect rate cards,
  reach and audience stats into a standardized, matchable blogger catalog.
  Behind feature flags (off by default); CustDev behavior is unchanged until
  enabled.
  - **Campaign-type builder**: describe a campaign goal in plain language and
    a meta-agent drafts the agent set (prompts, models, output schemas), dry-
    runs them, and saves an editable type — never auto-published.
  - **Agency dialogue**: agency-framed opener referencing the blogger's own
    ad, a data-collection planner, and a commercial-language safety profile;
    price/quote intents force operator handoff.
  - **Blogger catalog**: standardized profiles (rate cards, reach, audience)
    with per-fact provenance; uploaded media kits + raw replies stored in S3
    (presigned download).
  - **Matching**: submit an ad brief → ranked relevant bloggers with rationale
    (deterministic, optional bounded LLM re-rank).
  - Web: campaign-type builder, type-aware campaign goal editor, blogger
    catalog/profile views, and a brief→match screen.

- **Chat autonomy modes** — per-conversation `auto` / `semi_auto` / `assisted` /
  `manual` with a model-driven goal-fit gate (`GoalFitEvaluator`). In `auto`
  mode, when the gate detects the conversation has drifted off the campaign's
  AJTBD goal, the conversation flips silently to `assisted` — the operator
  picks up at human pace and the contact perceives nothing.
- **AJTBD framing on campaigns** — structured `Campaign.ajtbd` (job, when,
  forces, desired_outcome, non_goals) propagated into `ReplyComposer`,
  `HandoffDecider`, `SafetyFilter`, `GoalFitEvaluator`. AJTBD editor in the
  campaign settings page.
- **Quality-gate banner** on the inbox conversation header: when AI hands off
  silently, operator sees "AI handed off — <reason>" with a "Resume auto"
  button.
- **On-open conversation sync** — `GET /conversations/:id` now fetches missed
  TG messages (≤ 50, bounded, FloodWait-friendly, 30s cache) and feeds the
  most recent new inbound to the agent pipeline so suggestions reflect the
  latest state. Fixes "stale chat after worker restart" bug where messages
  received during downtime never reached the inbox until the next push.

### Changed

- **BREAKING**: `ConversationMode.auto` renamed to `semi_auto` (matches
  pre-existing behaviour). New `auto` mode introduces strict semantics with
  silent operator fallback. The enum value `semi_auto` is added by
  migration `4_chat_autonomous_modes`; existing legacy rows are
  backfilled to `semi_auto` by migration
  `9a_chat_modes_backfill_semi_auto` (split for the enum-in-tx fix —
  see `fix-migration-4-enum-tx`).
- `Campaign.defaultMode` is now applied to new conversations created under
  the campaign (previously it was set but never read).

### Operator notes

- Migration runbook for ops: see
  `openspec/changes/chat-autonomous-modes/RUNBOOK.md`.
