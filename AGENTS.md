# AGENTS.md

Спецификация мультиагентной системы под рекламную платформу: «публичный канал → явно опубликованный рекламный/business contact → прозрачный запрос условий размещения или исследовательское приглашение → диалог с операторским контролем».

## Scope и compliance

Система работает только с публичными страницами и контактами, которые сам автор/канал указал для рекламных, business или partnership-запросов: "по рекламе", "media kit", "manager", email/форма заявки для брендов. Личные контакты без business-контекста, закрытые данные, скрытие отправителя/цели обращения, обход ограничений платформ и массовая рассылка вне rate limits запрещены.

Ключевой product framing:
- `agency_sourcing` — основной рекламный сценарий: честно запросить условия размещения/интеграции у опубликованного advertising contact, собрать прайс/охваты/media kit и передать коммерческие решения оператору.
- `custdev` — исследовательский сценарий: честно пригласить на продуктовый разговор, не маскируя продажу или рекламную закупку под интервью.

Любой исходящий текст проходит safety/goal gates, честно обозначает отправителя и цель обращения, уважает opt-out/stop requests, сохраняется как `pending` перед отправкой, а агентский sourcing по умолчанию работает в `assisted` и требует подтверждения человеком для коммерческих условий.

## Контракт

```ts
interface Agent<TIn, TOut> {
  name: string;                     // ключ в agent_config.name
  description: string;
  inputSchema: ZodType<TIn>;
  outputSchema: ZodType<TOut>;
  variables: string[];              // имена {{var}} в промптах
  defaultConfig: PartialAgentConfig;
  run(input: TIn, ctx: AgentContext): Promise<TOut>;
}

interface AgentContext {
  llm: LLMProvider;          // выбран по endpoint_id из agent_config
  config: AgentConfig;
  channel?: Channel;
  contact?: Contact;
  conversation?: Conversation;
  campaign?: Campaign;
  logger: Logger;
  runId: string;
}
```

Базовый `run`:
1. Валидирует `input` через `inputSchema`.
2. Рендерит `system_prompt`, `user_prompt_template` с переменными.
3. Если задан `params.json_schema` — `llm.completeJson` с валидацией. Иначе — `llm.complete`.
4. При ошибке — retry → fallback endpoint.
5. Пишет `agent_run`.

---

## Состав агентов

### 1. ChannelAnalyzer — `channel_analyzer`
Описывает, что за канал и кому он принадлежит, чтобы потом писать персонализированно.

**Input**
```ts
{
  platform: 'telegram'|'instagram'|'youtube',
  title: string,
  description: string,
  links: string[],
  followers?: number,
  language_hint?: string,
  recent_posts: Array<{ date, text, urls: string[] }>
}
```

**Output**
```ts
{
  language: 'ru'|'en'|'other',
  topic: string,                // "стартап-новости", "финтех", "женский лайфстайл"
  audience: string,             // "B2B, founders/PMs", "девушки 18-25"
  format: string,               // "авторский блог", "новостной агрегатор", "видеоформат"
  tone: 'formal'|'casual'|'edgy'|'neutral',
  owner_signals: {
    is_personal_brand: boolean,
    owner_hint?: string         // что мы можем сказать о владельце
  },
  red_flags: string[]           // "адалт", "крипто-скам", "копипаста", "конкурент"
}
```

**Системный промпт** (RU, базовый — финальный текст в админке):
> Ты анализируешь публичный канал автора в соцсети. По названию, описанию, ссылкам и нескольким последним постам кратко описываешь его в структурированном виде. Не выдумывай факты. Если данных мало — честно отмечай низкие уровни уверенности и оставляй поля пустыми. Возвращай только JSON по схеме.

**Когда**: после успешной индексации публичной страницы канала, в пайплайне `extract_contacts`.

**Модель**: средняя (Yandex / Sonnet-уровень).

---

### 2. ContactExtractor — `contact_extractor`
Главный агент задачи. Выделяет из публичного описания канала только явно опубликованные advertising/business contacts и классифицирует их назначение.

**Input**
```ts
{
  platform: string,
  channel_title: string,
  description: string,
  links: string[],
  recent_posts_text: string,    // склейка последних постов (обрезанная)
  regex_candidates: Array<{     // предзаполняем регулярками
    type: 'tg_username'|'tg_link'|'email'|'phone'|'website'|'other',
    raw_value: string,
    context_snippet: string     // ±60 символов вокруг
  }>
}
```

**Output**
```ts
{
  contacts: Array<{
    type: 'tg_username'|'tg_link'|'email'|'phone'|'website'|'web_form'|'other',
    value: string,              // нормализованное (например, без @, без https://)
    raw_value: string,
    role_guess: 'owner'|'ad_manager'|'generic'|'bot'|'unknown',
    label?: string,             // фрагмент текста рядом ("по рекламе", "business", "manager")
    confidence: number,         // 0..1
    rationale: string           // короткое объяснение
  }>,
  no_contacts_reason?: string   // если совсем ничего нет — почему
}
```

**Логика работы (внутри `run`)**:
1. Регулярки уже отработали в предобработчике — приходят в `regex_candidates`.
2. LLM получает на вход: канал + полный список кандидатов + куски контекста.
3. Возвращает классификацию по каждому кандидату + при необходимости добивает то, что регулярки не поймали, но только если рядом есть business/ad-контекст (например, "по рекламе писать @manager").
4. После LLM — детерминированный пост-процесс: дедуп по `(type, value)`, нормализация (`@user` → `user`, `https://` обрезается), отбрасывание confidence < `params.min_confidence` (по умолчанию 0.4).

**Системный промпт** (фрагмент):
> Ты ищешь в публичном описании и постах канала контакты, которые сам автор/канал явно указал для рекламных, business или partnership-запросов. Тебе уже дали список найденных кандидатов регулярками — твоя задача классифицировать каждого: это рекламный менеджер, владелец, бот/форма для заявок, общий business contact или нерелевантно. Не добавляй личные контакты без business/ad-контекста. Не выдумывай контакты, которых нет в тексте. Возвращай JSON по схеме. Конкретные типы:
> - `owner` — аккаунт автора канала, только если он явно указан как канал для business/ad связи
> - `ad_manager` — отдельный аккаунт/почта/форма "по рекламе", media kit, менеджер
> - `bot` — бот для заявок (`@xxxbot`, ссылка на форму)
> - `generic` — общий business contact без явной роли
> - `unknown` — не удалось определить

**Params** (специфичные):
- `min_confidence` (default 0.4)
- `prefer_ad_manager_for_outreach` (default true) — приоритет в порядке сортировки

**Когда**: пайплайн `extract_contacts` после `ChannelAnalyzer`.

**Модель**: средняя, structured output (`yandexgpt` / `gpt-4o` / `claude-haiku`+).

---

### 3. ContactPrioritizer — `contact_prioritizer`
Если у канала несколько публичных business/ad contacts — какой брать для рекламного запроса или operator review. Простой, но удобно вынести.

**Input**: `{ contacts: Contact[], channel_analysis }`

**Output**: `{ ranked: Array<{ contact_id, score, reason }> }`

**Правила** (детерминированные, LLM-вызов опционален в серых случаях):
- `ad_manager` > `owner` > `generic` > `bot` > `unknown`
- Среди равных — `tg_username` > `tg_link` > `email` > остальное
- Высший confidence
- Если `channel_analysis.is_personal_brand=true` → `owner` поднимается на уровень `ad_manager`

**Когда**: при подготовке к operator review / отправке (либо при подготовке кампании-превью).

**Модель**: можно без LLM. Если включить — дешёвая.

---

### 4. ApproachStrategist — `approach_strategist`
Выбирает угол захода под тип кампании: рекламный запрос условий (`agency_sourcing`) или исследовательское приглашение (`custdev`).

**Input**: `{ channel_analysis, contact, campaign: { goal_text, value_prop, examples? } }`

**Output**
```ts
{
  approach: 'industry_fit'|'audience_fit'|'recent_post_hook'|'peer'|'compliment_then_ask',
  hook: string,                 // конкретная зацепка (тематика канала / свежий пост)
  why_them: string,             // 1 фраза — почему именно их
  tone: 'formal'|'casual'|'peer',
  do_avoid: string[]
}
```

**Модель**: средняя.

---

### 5. OpeningComposer — `opening_composer`
Пишет 2–3 варианта первого сообщения для `custdev`. Рекламные запросы условий размещения пишет отдельный `AgencyOpeningComposer`.

**Input**: `{ channel_analysis, contact, strategy, campaign: { goal_text, value_prop }, examples?: string[] }`

**Output**
```ts
{
  variants: Array<{
    text: string,               // не длиннее 600 символов
    rationale: string,
    length: 'short'|'medium'|'long',
    risk_score: number          // 0..1, самооценка compliance/spam-риска
  }>
}
```

**Системный промпт** (ключевые правила, в админке шлифуется):
> Ты пишешь первое сообщение на публично указанный business/ad contact канала с приглашением на 20-минутное **исследовательское интервью по продукту**. Это `custdev`, а не рекламная закупка: не имитируй коммерческий запрос и не обещай размещение. Цель — честно узнать, готов ли собеседник на короткое интервью.
>
> Жёсткие правила:
> - Не маскируй продажу или рекламную закупку под интервью; если цель кампании — запросить прайс/условия рекламы, используй `agency_sourcing`.
> - Покажи, что прочитал канал. 1 конкретная деталь из тематики/постов.
> - Назови продукт и роль интервью одним предложением.
> - Чётко обозначь длительность (15–20 минут) и компенсацию из value-prop.
> - Не давай ссылок без причины. Не используй эмодзи в начале.
> - 2–4 предложения. Звучи как живой человек и уважай отказ/stop request.
> - Если уверенность низкая — лучше короче и проще.

**Когда**: пайплайн `outreach_first_message`.

**Модель**: сильная (Yandex Pro / Sonnet / Opus).

---

### 6. ReplyComposer — `reply_composer`
Подсказки в активном диалоге.

**Input**
```ts
{
  channel_analysis,
  contact,
  campaign,
  conversation_history: Array<{ direction, sender, text, at }>,
  conversation_summary?: string,
  last_inbound: { text, intent, sentiment }
}
```

**Output**
```ts
{
  variants: Array<{
    text: string,
    intent_target: 'qualify'|'schedule_call'|'answer_question'|'handle_objection'|'soft_close'|'small_talk',
    rationale: string
  }>
}
```

**Когда**: пайплайн `on_inbound`, если `HandoffDecider` разрешил.

**Модель**: сильная.

---

### 7. IntentClassifier — `intent_classifier`
Классифицирует входящее под `custdev` и `agency_sourcing` сценарии.

**Input**: `{ last_inbound: string, history_tail: string[] }`

**Output**
```ts
{
  intent:
    'interested'|'needs_more_info'|'asks_about_product'|'objection_busy'|
    'objection_irrelevant'|'objection_compensation'|'wants_payment_for_ads'|  // CustDev: собеседник трактует сообщение как рекламный запрос
    'wants_to_schedule'|'declined'|'hostile'|'spam_complaint'|
    'request_human'|'silence_likely',
  confidence: number,
  signals: string[]
}
```

`wants_payment_for_ads` — важный интент для `custdev`: собеседник трактует исследовательское приглашение как рекламный запрос. Это не ошибка собеседника; система эскалирует на оператора и помечает диалог для анализа framing. В `agency_sourcing` коммерческие ответы классифицируются как `discusses_price` / `sends_quote` и тоже передаются оператору для подтверждения условий.

**Модель**: дешёвая, structured output.

---

### 8. SafetyFilter — `safety_filter`
Финальная проверка любого исходящего. Проверяет прозрачность цели, opt-out, отсутствие давления и соответствие `campaign_type`.

**Input**: `{ draft, channel_analysis, contact, campaign }`

**Output**
```ts
{
  allow: boolean,
  reasons: string[],
  rewrite_hint?: string,
  risk_score: number          // 0..1
}
```

**Что блокирует**:
- Слова из `params.forbidden_topics`. Для `custdev` по умолчанию рекламная лексика повышает риск, чтобы исследовательское интервью не выглядело как скрытая закупка. Для `agency_sourcing` рекламная лексика разрешена профилем типа, потому что цель — честно запросить условия размещения.
- Обещания результата («увеличим», «гарантируем»).
- Конкретные цифры/сроки, не подтверждённые в кампании.
- Эмодзи в начале сообщения, восклицательные знаки в первой строке.
- Нарушение «не пиши, если попросили не писать» (детектится по истории — если входящее = `declined`, исходящее не уходит без оператора).
- Ссылки без причины (если в кампании не разрешены).
- Длина > `params.max_length` (по умолчанию 600).
- Любая попытка писать не на явно опубликованный business/ad contact без ручного подтверждения.

**Когда**: перед каждой отправкой.

**Модель**: дешёвая, structured output.

---

### 9. HandoffDecider — `handoff_decider`
Решает, продолжает ли ИИ.

**Input**
```ts
{
  conversation: { mode, summary, last_inbound, history_tail },
  intent: { intent, confidence },
  ai_recent_confidence: number[],
  red_flags_total: number
}
```

**Output**
```ts
{
  action: 'ai_continue'|'ai_suggest_only'|'operator_now',
  reason: string,
  urgency: 'low'|'normal'|'high'
}
```

**Детерминированные правила (до LLM)**:
- `intent in (hostile, spam_complaint, request_human, wants_payment_for_ads)` → `operator_now (high)`.
- `intent == wants_to_schedule` → `operator_now (high)` (живой человек подтверждает время).
- 2 подряд `confidence < 0.5` → `ai_suggest_only`.
- Стоп-слова из `params.escalation_keywords` → `operator_now`.
- Иначе — спрашиваем модель.

**Модель**: дешёвая.

---

### 10. ConversationSummarizer — `conversation_summarizer`
Сжимает историю каждые N (=20) новых сообщений.

**Input**: `{ history, previous_summary? }`
**Output**: `{ summary, key_facts, open_questions }`

**Модель**: средняя.

---

### 11. NextActionPlanner — `next_action_planner`
Что делать дальше с диалогом.

**Input**: `{ conversation_state, intent_history, contact_meta }`

**Output**
```ts
{
  next_action: 'send_now'|'wait_hours'|'send_followup_at'|'close'|'escalate',
  scheduled_at?: ISODate,
  reason: string
}
```

**Когда**: после `on_inbound` (когда отвечать) и в `followup_check` (cron).

**Модель**: средняя.

---

### 12. QualityReviewer — `quality_reviewer` (опц., off-line)
Семплирует исходящие для оценки. Не блокирует отправку.

**Input**: `{ draft, conversation_history, channel_analysis, contact }`
**Output**: `{ scores: { relevance, tone, grammar, personalization, on_brief }, notes }` — каждое 1..5.

`on_brief` — соответствие цели кампании: для `custdev` не свалились в продажу, для `agency_sourcing` честно запросили рекламные условия без давления и выдуманных обещаний.

**Когда**: cron на 5–10% исходящих.
**Модель**: сильная.

---

### 13. GoalFitEvaluator — `goal_fit_evaluator`
Quality-gate авто-режима: оценивает goal-fit черновика и истории к AJTBD кампании. Запускается только в `semi_auto` / `auto` (skip для `manual` / `assisted`).

**Input**
```ts
{
  ajtbd: CampaignAjtbd,
  history_tail: string[],   // последние ≤ 8 строк
  intent: { intent, confidence },
  handoff: { action, reason },
  draft: string,            // top variant от reply_composer
  previous_decision: { score, action, decidedAt } | null
}
```

**Output**
```ts
{
  score: 0..1,
  action: 'continue' | 'soften' | 'handoff_silent',
  reasons: string[]
}
```

**Композиция с другими сигналами** (см. `apps/workers/src/services/auto-approve.ts`):
- `mode = manual | assisted`: gate не запускается, авто-отправки нет.
- `mode = semi_auto`: авто-отправка iff `safety.allow && (1 - risk_score) ≥ T_safety && gate.action ∈ {continue, soften} && gate.score ≥ T_semi_auto_goalfit`.
- `mode = auto`: авто-отправка iff то же + `gate.action == continue` + `gate.score ≥ T_auto_goalfit`.

**Hysteresis** (борьба с одиночными ложными хэндоффами): `handoff_silent` переводит диалог в `assisted` ТОЛЬКО когда (а) предыдущее решение тоже было `handoff_silent`, ИЛИ (б) текущий `score ≤ 0.3`.

**Silent fallback contract**: при флипе из `auto` в `assisted` система:
- НЕ создаёт исходящих сообщений и не ставит задачи в `tg-send`,
- НЕ публикует событий в контактные realtime-каналы,
- эмитит `quality.gate` событие ТОЛЬКО в operator-room,
- оставляет лучший safe-черновик как `pending` suggestion для оператора.

Контакт видит только естественную задержку оператора — никаких "сейчас передаю человеку" или резких изменений тона.

**Модель**: дешёвая (Haiku-class). Cap on input: 8 trailing messages, 350 max_tokens.

---

## Режимы диалога (`Conversation.mode`)

| Режим | Кто отвечает | Gate | Auto-send |
|---|---|---|---|
| `manual` | только оператор | skip | нет |
| `assisted` | оператор подтверждает draft | skip | нет |
| `semi_auto` | система может отправить только после safety/goal gates, иначе draft оператору | runs | iff safety + gate (`continue`/`soften`) ≥ `T_semi_auto_goalfit` |
| `auto` | строгий авто-режим только для разрешённых кампаний и опубликованных business/ad contacts; молчаливый фоллбек | runs | iff safety + gate == `continue` ≥ `T_auto_goalfit` |

**Пороги по умолчанию** (env-tunable, см. `auto-approve.ts`):
- `T_safety = 0.8` — `(1 - risk_score)` от `safety_filter`.
- `T_semi_auto_goalfit = 0.6` — gate.score для semi_auto.
- `T_auto_goalfit = 0.75` — gate.score для строгого auto.

Per-campaign override через `Campaign.agentOverrides.goal_fit_evaluator.params`.

---

## Пайплайны

Пайплайны — данные (`Pipeline = { steps: Step[] }`), исполняются `Orchestrator`.

### `extract_contacts`
Триггер: `channel.status=scraped` после индексации публичной страницы.
```
1. ChannelAnalyzer            → channel.analysis
2. (если red_flags из ChannelAnalyzer) → channel.status=disqualified, выход
3. regex_extract              → пред-кандидаты из публичного текста (детерминированный шаг, не агент)
4. ContactExtractor           → массив явно опубликованных business/ad contacts (с типом, ролью, confidence)
5. dedupe_normalize           → пишем contact-ы в БД с reachability
6. (для tg_username) tg_resolve → tg_user_id (или status=invalid)
7. channel.status=extracted
```

### `outreach_first_message`
Триггер: диспетчер кампании выбрал публично указанный business/ad contact или оператор подтвердил контакт вручную.
```
1. (если contact.priority неизвестен) ContactPrioritizer
2. (если channel.analysis устарел) ChannelAnalyzer
3. ApproachStrategist          → strategy
4. OpeningComposer             → variants[]
5. for each variant: SafetyFilter
   if !allow и есть rewrite_hint → 1 ретрай OpeningComposer с hint
6. Пишем suggestion-ы (score = (1 - risk_score) * model_self_score)
7. if campaign.mode == 'auto' и top.risk_score < threshold и contact разрешён policy:
      message(pending) + tg-send (с задержкой)
   else:
      оператор увидит в Inbox
```

### `on_inbound`
Триггер: входящее сообщение (push-листенер `tg-listen` или on-open sync — см. `apps/api/src/services/conversation-sync.ts`).

```
1. resolveCampaignAjtbd(conv.campaign) — загружаем AJTBD один раз на run.
   Если кампания есть, но ajtbd null/невалиден — fail explicit (не молчим).
2. (если history_len % 20 == 0) ConversationSummarizer
3. IntentClassifier
4. HandoffDecider (получает ajtbd: non_goals, desired_outcome)
5. if handoff.action == 'operator_now':
     conversation.mode = 'manual'; notify operator; gate skipped.
6. ReplyComposer (получает ajtbd) → variants[]
7. for each variant: SafetyFilter (получает ajtbd_non_goals)
   → пишем `pending` suggestion для каждого safe-варианта.
8. if conv.mode ∈ {semi_auto, auto} AND есть safe-вариант AND ajtbd:
     GoalFitEvaluator(ajtbd, history_tail≤8, intent, handoff, top.draft,
                      previous_decision)
     → tx: persist Conversation.qualityDecision (всегда),
            optionally Conversation.mode = 'assisted' (по hysteresis).
     → publishRealtime('quality.gate', operator-room only).
     → if flipped to 'assisted': оставить best suggestion `pending`,
        НЕ enqueue tg-send, НЕ создавать исходящее. Return.
9. tryAutoApprove(conversationId, suggestionId, text, score, gate?):
     Композиция safety + gate + mode (см. таблицу выше).
     Если разрешено policy/safety/rate limits — message(pending) + tg-send.
```

**Conversation sync на открытии**: при `GET /conversations/:id` API вызывает `ConversationSync.syncOne(id)` с hard-budget 1500мс. Sync дёргает `messages.getHistory` через `tg-client.fetchHistorySince`, дедуплицирует по `Message.tgMsgId`, сохраняет пропущенные inbound через тот же путь, что `tg-listen`, и enqueue-ит `agent-run on_inbound` ТОЛЬКО для самого свежего нового inbound. Лимит 50 сообщений descending; FloodWait → лог + counter `tg.flood_wait`, без retry inline.

### `followup_check` (cron)
```
SELECT conversations WHERE status=active
  AND last_outbound_at < now - X
  AND NOT EXISTS (inbound after last_outbound_at)
для каждой:
  ConversationSummarizer (если нужно)
  NextActionPlanner
  switch:
    'send_followup_at': ReplyComposer + SafetyFilter → suggestion (auto/manual по mode)
    'close':            conversation.status='done'
    'escalate':         mode='manual', notify
```

### `quality_review` (cron, sample)
```
Семпл 5–10% свежих исходящих → QualityReviewer → agent_run → дашборд
```

---

## Конфигурация в админке

Карточка агента (одна форма для всех):

- **Endpoint** (выпадашка `endpoint`)
- **Fallback endpoint**
- **Model** (текст с подсказками каталога провайдера)
- **System prompt** (textarea, переменные `{{var}}` подсвечиваются и валидируются — все объявленные `variables` агента должны использоваться или быть optional)
- **User prompt template** (textarea)
- **Temperature, max_tokens, top_p**
- **JSON schema (output)** — валидируется на совместимость с `outputSchema` агента
- **Specific params** (нативные поля под агента):
  - `ContactExtractor`: `min_confidence`, `enable_llm_classification`
  - `SafetyFilter`: `forbidden_topics[]`, `escalation_keywords[]`, `max_length`, `allow_links`
  - `HandoffDecider`: `confidence_threshold`, `escalation_keywords[]`
  - и т.д.
- **Test** — пресеты тестовых input-ов из `agent_test_fixtures`, реальный вызов с `dry_run`
- **Save** — новая версия в `agent_config_history`
- **History / Diff / Rollback**

`campaign.agent_overrides` — частичный конфиг, мерджится поверх глобального только в рамках кампании.

---

## Дефолтные модели

| Агент | Класс | Пример |
|---|---|---|
| ChannelAnalyzer | средняя, JSON | `yandexgpt` / `claude-haiku` |
| ContactExtractor | средняя, JSON | `yandexgpt` / `gpt-4o` / `claude-haiku` |
| ContactPrioritizer | дешёвая или без LLM | `yandexgpt-lite` / детерминированно |
| ApproachStrategist | средняя | `yandexgpt` / `claude-haiku` |
| OpeningComposer | сильная | `yandexgpt/rc` / `claude-sonnet` / `gpt-5` |
| ReplyComposer | сильная | то же |
| IntentClassifier | дешёвая, JSON | `yandexgpt-lite` / `gpt-4o-mini` |
| SafetyFilter | дешёвая, JSON | то же |
| HandoffDecider | дешёвая, JSON | то же |
| ConversationSummarizer | средняя | `yandexgpt` / `claude-haiku` |
| NextActionPlanner | средняя | то же |
| QualityReviewer | сильная | `claude-sonnet` / `gpt-5` |

Экономика: `agent_run` пишет токены и стоимость. На дашборде — `cost_per_channel_extracted`, `cost_per_first_message`, `cost_per_reply`, `cost_per_qualified_lead`. При превышении `cost_cap_usd_per_day` — пайплайн ставится на паузу + алерт.

---

## Тестирование

- Каждый агент: unit с замоканным `LLMProvider`. Проверяем маппинг переменных, валидацию выхода, retry/fallback.
- `agent_test_fixtures` — репрезентативные input-ы. Используются и в админке (Test), и в CI (golden tests с диффом по структуре).
- `ContactExtractor` дополнительно: набор реальных описаний каналов (anonymized) с разметкой ожидаемых контактов — это самый ценный тест-набор.
- Регрессы по реальным диалогам: дамп N анонимизированных диалогов, прогон `on_inbound`, человек оценивает.
- A/B по версиям промптов: сравнение `reply_rate`, `qualified_rate`, `cost_per_reply` между версиями `agent_config_history`.

---

## Что хочется добавить позже

- **PolicyAgent** — соответствие политикам кампании (бренд-голос, запрещённые формулировки) отдельно от SafetyFilter.
- **MemoryAgent** — долговременная память по контакту между кампаниями.
- **Inline-обучение** — оператор оценивает каждую подсказку (👍/👎 + комментарий) → данные накапливаются в `suggestion.feedback` и используются как few-shot в композерах.
- **Email-композер** — отдельный агент с другим этикетом для email-канала отправки.

---

## Агентство и подбор (типы кампаний)

Поведение пайплайнов теперь задаёт `campaign_type` (реестр, см. `DESIGN.md`):
`agent_set` (роль → агент + оверрайды), `safety_profile`, `autonomy_policy`,
`goal_schema`. Всё за фичефлагами (по умолчанию off) — при выключенных
поведение CustDev байт-в-байт. `SafetyFilter` получает `forbidden_topics`/
`allowed_topics` из `safety_profile` типа (custdev — запрет рекламной лексики
через risk; agency — она разрешена, запрещены гарантии/давление/деньги).

`agency_sourcing` разрешён только для каналов/авторов с публично указанным
advertising/business contact. Сообщение должно прямо обозначать рекламный
контекст: запросить прайс, формат, охваты, media kit или условия интеграции.
Если контакт не маркирован как рекламный/business или автор попросил не писать,
авто-отправка запрещена, диалог остаётся оператору.

### Новые агенты

- **CampaignTypeBuilder — `campaign_type_builder`.** Мета-агент: из описания
  цели кампании на естественном языке драфтит `goal_schema`, `safety_profile`
  и по агенту на каждую pipeline-роль (промпты, модель по tier из
  capability-map, params, output-schema). Драфт прогоняется через `dryRun`
  (токены/стоимость/латентность прикладываются) и НЕ публикуется до явного
  Save (тогда создаются `agent_config` v1 + `agent_config_history`, аудит).
- **AgencyOpeningComposer — `agency_opening_composer`.** Первое сообщение от
  лица агентства на публично указанный advertising/business contact: честно
  запрашивает условия размещения/интеграции и может ссылаться только на реально
  наблюдаемую интеграцию в постах канала. Детерминированный no-fabrication guard:
  нет наблюдаемой интеграции или явно рекламного/business contact → нет авто-отправки;
  цитируемый бренд обязан встречаться и в тексте.
- **DataCollectionPlanner — `data_collection_planner`.** Логика сбора данных:
  missing = target − collected, задаёт один недостающий вопрос за ход, не
  переспрашивает собранное, не давит на собеседника и уважает отказ/stop request,
  авторитетный сигнал goal-satisfied. ПОДКЛЮЧЁН в
  агентский inbound-пайплайн (за `ENABLE_AGENCY_SOURCING`): для
  `agency_sourcing`-конверсаций он ведёт диалог вместо `reply_composer` —
  `target_data_points` берутся из `campaign.goal` (или дефолтный набор),
  `collected` маппится из полей `profile_data_point` блогера; его единственный
  reply идёт через тот же safety/gate/auto-approve путь.
- **RateCardExtractor / AudienceStatsExtractor.** Парсят свободный текст
  блогера в `profile_data_point` (`rate.*`, `reach.*`, `audience.*`) с
  confidence и сырым `raw_snippet`; низкая уверенность не выкидывается.
- **BloggerMatcher — `blogger_matcher`.** Опциональный LLM-реранк топ-N
  кандидатов под бриф; по умолчанию off (детерминированный скоринг без LLM).

### Интенты и режимы

`IntentClassifier` получил `discusses_price` / `sends_quote` — для
`agency_sourcing` они в `autonomy_policy.forceHandoffIntents` и форсят
`operator_now` (человек подтверждает коммерческие условия, бюджет, сроки и
следующий шаг). Дефолтный режим `agency_sourcing` — `assisted`.
`agent-run` и `campaign-dispatcher` резолвят
агента роли через `resolveAgentName(type.agentSet, role, fallback)` за
`ENABLE_AGENCY_SOURCING`.

### Пайплайн агентского inbound (поверх `on_inbound`)

Для `agency_sourcing`-конверсаций (за флагом): опенер резолвится из
`agent_set` (`agency_opening_composer`); на inbound вместо `reply_composer`
работает `data_collection_planner` (следующий недостающий пункт / закрытие).
После inbound в очередь `profile-extract` уходит извлечение прайсов/охватов в
`profile_data_point` + детерминированный roll-up в `blogger_profile`; входящие
файлы оседают в S3 (`media_asset`). Интенты `discusses_price`/`sends_quote`
форсят `operator_now`. Всё за `ENABLE_AGENCY_SOURCING`; при выключенном флаге
путь CustDev байт-в-байт.
