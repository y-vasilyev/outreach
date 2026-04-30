# AGENTS.md

Спецификация мультиагентной системы под задачу: «канал → контакты для рекламы → CustDev-приглашение → диалог».

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

**Когда**: после успешного скрейпа канала, в пайплайне `extract_contacts`.

**Модель**: средняя (Yandex / Sonnet-уровень).

---

### 2. ContactExtractor — `contact_extractor`
Главный агент задачи. Достаёт из описания канала контакты для рекламы, классифицирует.

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
    label?: string,             // фрагмент текста рядом ("по рекламе", "manager")
    confidence: number,         // 0..1
    rationale: string           // короткое объяснение
  }>,
  no_contacts_reason?: string   // если совсем ничего нет — почему
}
```

**Логика работы (внутри `run`)**:
1. Регулярки уже отработали в предобработчике — приходят в `regex_candidates`.
2. LLM получает на вход: канал + полный список кандидатов + куски контекста.
3. Возвращает классификацию по каждому кандидату + при необходимости добивает то, что регулярки не поймали (например, контакт упомянут в посте словами «писать в директ к @vasya»).
4. После LLM — детерминированный пост-процесс: дедуп по `(type, value)`, нормализация (`@user` → `user`, `https://` обрезается), отбрасывание confidence < `params.min_confidence` (по умолчанию 0.4).

**Системный промпт** (фрагмент):
> Ты ищешь в описании и постах канала контакты, по которым можно написать «по рекламе» или «по сотрудничеству». Тебе уже дали список найденных кандидатов регулярками — твоя задача классифицировать каждого: это владелец канала, рекламный менеджер, бот для заявок, общий контакт или нерелевантно. Если в тексте есть контакты, которые регулярки пропустили (например, упомянуты словами) — добавь их. Не выдумывай контакты, которых нет в тексте. Возвращай JSON по схеме. Конкретные типы:
> - `owner` — личный аккаунт автора канала
> - `ad_manager` — отдельный аккаунт «по рекламе», менеджер
> - `bot` — бот для заявок (`@xxxbot`, ссылка на форму)
> - `generic` — контакт без явной роли
> - `unknown` — не удалось определить

**Params** (специфичные):
- `min_confidence` (default 0.4)
- `prefer_ad_manager_for_outreach` (default true) — приоритет в порядке сортировки

**Когда**: пайплайн `extract_contacts` после `ChannelAnalyzer`.

**Модель**: средняя, structured output (`yandexgpt` / `gpt-4o` / `claude-haiku`+).

---

### 3. ContactPrioritizer — `contact_prioritizer`
Если у канала несколько контактов — какой брать на outreach. Простой, но удобно вынести.

**Input**: `{ contacts: Contact[], channel_analysis }`

**Output**: `{ ranked: Array<{ contact_id, score, reason }> }`

**Правила** (детерминированные, LLM-вызов опционален в серых случаях):
- `ad_manager` > `owner` > `generic` > `bot` > `unknown`
- Среди равных — `tg_username` > `tg_link` > `email` > остальное
- Высший confidence
- Если `channel_analysis.is_personal_brand=true` → `owner` поднимается на уровень `ad_manager`

**Когда**: при подготовке к отправке (либо при подготовке кампании-превью).

**Модель**: можно без LLM. Если включить — дешёвая.

---

### 4. ApproachStrategist — `approach_strategist`
Выбирает угол захода для CustDev-приглашения.

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
Пишет 2–3 варианта первого сообщения с CustDev-приглашением.

**Input**: `{ channel_analysis, contact, strategy, campaign: { goal_text, value_prop }, examples?: string[] }`

**Output**
```ts
{
  variants: Array<{
    text: string,               // не длиннее 600 символов
    rationale: string,
    length: 'short'|'medium'|'long',
    risk_score: number          // 0..1, самооценка спам-риска
  }>
}
```

**Системный промпт** (ключевые правила, в админке шлифуется):
> Ты пишешь первое сообщение в личку незнакомому автору канала с приглашением на 20-минутное **исследовательское интервью по продукту**. Цель — НЕ продать, НЕ предложить рекламу, НЕ запитчить. Только узнать, готов ли он на короткое интервью.
>
> Жёсткие правила:
> - Не используй слова «реклама», «рекламная интеграция», «сотрудничество», «созвониться обсудить».
> - Покажи, что прочитал канал. 1 конкретная деталь из тематики/постов.
> - Назови продукт и роль интервью одним предложением.
> - Чётко обозначь длительность (15–20 минут) и компенсацию из value-prop.
> - Не давай ссылок без причины. Не используй эмодзи в начале.
> - 2–4 предложения. Звучи как живой человек, не как бот.
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
Классифицирует входящее под CustDev-сценарий (расширенный набор).

**Input**: `{ last_inbound: string, history_tail: string[] }`

**Output**
```ts
{
  intent:
    'interested'|'needs_more_info'|'asks_about_product'|'objection_busy'|
    'objection_irrelevant'|'objection_compensation'|'wants_payment_for_ads'|  // важный сигнал — он принял за продажу рекламы
    'wants_to_schedule'|'declined'|'hostile'|'spam_complaint'|
    'request_human'|'silence_likely',
  confidence: number,
  signals: string[]
}
```

`wants_payment_for_ads` — особо важный интент: значит наша CustDev-формулировка не сработала, человек считает, что мы хотим купить рекламу. Эскалация на оператора + флаг для аналитики промптов.

**Модель**: дешёвая, structured output.

---

### 8. SafetyFilter — `safety_filter`
Финальная проверка любого исходящего. Особо строг под CustDev.

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
- Слова из `params.forbidden_topics` (по умолчанию: `["реклама", "рекламная", "интеграц", "купить рекламу", "разместить", "промо", "приобрести", "оффер", "выгодное предложение"]`).
- Обещания результата («увеличим», «гарантируем»).
- Конкретные цифры/сроки, не подтверждённые в кампании.
- Эмодзи в начале сообщения, восклицательные знаки в первой строке.
- Нарушение «не пиши, если попросили не писать» (детектится по истории — если входящее = `declined`, исходящее не уходит без оператора).
- Ссылки без причины (если в кампании не разрешены).
- Длина > `params.max_length` (по умолчанию 600).

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

`on_brief` — соответствие CustDev-цели (не свалились в продажу).

**Когда**: cron на 5–10% исходящих.
**Модель**: сильная.

---

## Пайплайны

Пайплайны — данные (`Pipeline = { steps: Step[] }`), исполняются `Orchestrator`.

### `extract_contacts`
Триггер: `channel.status=scraped`.
```
1. ChannelAnalyzer            → channel.analysis
2. (если red_flags из ChannelAnalyzer) → channel.status=disqualified, выход
3. regex_extract              → пред-кандидаты (детерминированный шаг, не агент)
4. ContactExtractor           → массив контактов (с типом, ролью, confidence)
5. dedupe_normalize           → пишем contact-ы в БД с reachability
6. (для tg_username) tg_resolve → tg_user_id (или status=invalid)
7. channel.status=extracted
```

### `outreach_first_message`
Триггер: диспетчер кампании выбрал контакт.
```
1. (если contact.priority неизвестен) ContactPrioritizer
2. (если channel.analysis устарел) ChannelAnalyzer
3. ApproachStrategist          → strategy
4. OpeningComposer             → variants[]
5. for each variant: SafetyFilter
   if !allow и есть rewrite_hint → 1 ретрай OpeningComposer с hint
6. Пишем suggestion-ы (score = (1 - risk_score) * model_self_score)
7. if campaign.mode == 'auto' и top.risk_score < threshold:
      message(pending) + tg-send (с задержкой)
   else:
      оператор увидит в Inbox
```

### `on_inbound`
Триггер: входящее сообщение.
```
1. (если history_len % 20 == 0) ConversationSummarizer
2. IntentClassifier
3. HandoffDecider
4. switch action:
     'operator_now':
        conversation.mode = 'manual'
        notify operator с причиной и urgency
     'ai_suggest_only':
        conversation.mode = 'assisted'
        ReplyComposer (2 варианта) → SafetyFilter → suggestion-ы
     'ai_continue':
        ReplyComposer (2 варианта) → SafetyFilter → NextActionPlanner
        if scheduled_at вблизи (< 1 мин):
           message(pending) + tg-send
        else:
           suggestion-ы + scheduled_at, отправит cron
```

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
