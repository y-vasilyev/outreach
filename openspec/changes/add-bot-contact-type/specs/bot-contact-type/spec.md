## ADDED Requirements

### Requirement: `bot` contact type for advertising/intake bots

The system SHALL support a `bot` value in the `ContactType` enum, representing an explicitly-published advertising or intake Telegram bot (e.g. a blogger stating "по рекламе — @hadeout_bot"). The `bot` type SHALL be defined consistently in every contact-type definition: the Prisma `ContactType` enum, the shared TypeScript `ContactType` union, the shared `ContactTypeZ` zod enum, and the web `ContactType` union. The contact-type axis (`type`) SHALL remain orthogonal to the actor axis (`RoleGuess`); a `bot` contact MAY carry any `roleGuess` (e.g. `ad_manager`).

#### Scenario: `bot` is an accepted contact type everywhere
- **WHEN** a contact is created or validated with `type = 'bot'` through the API, worker, or shared schema
- **THEN** validation passes and the contact is persisted with `type = 'bot'` without falling back to `other` or being rejected

#### Scenario: type and role stay independent
- **WHEN** an ad bot is stored as the published ad contact
- **THEN** the contact MAY have `type = 'bot'` together with `roleGuess = 'ad_manager'`, and neither value forces the other

### Requirement: Extraction classifies ad-intake bot handles as `bot`

The `ContactExtractor` SHALL classify a Telegram handle matching the bot-suffix pattern (`_bot`/`bot`) as `type = 'bot'` WHEN the surrounding context indicates an advertising or business-intake purpose (e.g. "по рекламе", "реклама", "сотрудничество", "прайс", media kit, "заявки в бот"). When a bot-suffix handle has no advertising/business context, the extractor SHALL continue to reject it (it is not ingested as a sourcing contact). Low-confidence classifications SHALL be flagged with a rationale rather than dropped silently, and each extraction run SHALL write an `agent_run`.

#### Scenario: Published ad bot is extracted as `bot`
- **WHEN** a channel's public page states "по рекламе писать в @hadeout_bot"
- **THEN** the extractor emits a contact with `type = 'bot'` and a confidence/rationale, and an `agent_run` row is written

#### Scenario: Bot handle without ad context is rejected
- **WHEN** a page mentions a `*_bot` handle with no advertising or business-intake context
- **THEN** the extractor does not emit it as a `bot` contact (rejection behavior is preserved)

#### Scenario: Ambiguous classification is flagged not dropped
- **WHEN** the extractor is unsure whether a `*_bot` handle is an ad intake bot
- **THEN** it emits the candidate with low confidence and a rationale so an operator can review, rather than discarding it

### Requirement: Manual creation and auto-detection of `bot`

Manual contact creation SHALL allow operators to choose `bot` explicitly, and the auto-detection path (`detectContactType`) SHALL classify a normalized `*_bot` Telegram handle as `type = 'bot'`. The stored `value` SHALL be normalized to the same `@handle` form used for `tg_username`.

#### Scenario: Auto-detect resolves a bot handle
- **WHEN** an operator pastes `@hadeout_bot` (or `t.me/hadeout_bot`) into create-with-auto-detect
- **THEN** the contact is created with `type = 'bot'` and a normalized `@hadeout_bot` value

#### Scenario: Operator selects bot type explicitly
- **WHEN** an operator picks `bot` as the type in the create dialog or edit drawer
- **THEN** the contact is saved with `type = 'bot'`

### Requirement: Reachability and dispatch eligibility for `bot`

A `bot` contact SHALL have reachability `reachable_tg` (a Telegram bot is reachable via direct message). However, the campaign dispatcher SHALL exclude `type = 'bot'` contacts from automated `agency_sourcing` selection even though they are `reachable_tg`, so that bot contacts are handled by an operator (manual/assisted) rather than receiving an auto-sent human-framed opener.

#### Scenario: Bot is reachable but not auto-dispatched
- **WHEN** the campaign dispatcher selects contacts for an `agency_sourcing` campaign
- **THEN** contacts with `type = 'bot'` are excluded from the auto-send selection even though their reachability is `reachable_tg`

#### Scenario: Reachability reflects TG-reachable
- **WHEN** a `bot` contact is persisted
- **THEN** its `reachability` is set to `reachable_tg`

### Requirement: Operator surfacing of `bot` contacts

The web contact UI SHALL expose `bot` as a selectable type filter, a create-dialog option, and an edit-drawer option, and SHALL render a distinct icon/badge for `bot` contacts so operators can recognize an ad bot at a glance.

#### Scenario: Bot type is filterable and visible
- **WHEN** an operator opens the contacts list and the type filter
- **THEN** `bot` appears as a filter option, and contacts of `type = 'bot'` display a distinct icon/badge distinguishing them from `tg_username` contacts
