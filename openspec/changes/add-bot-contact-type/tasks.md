## 1. Schema & migration

- [x] 1.1 Add `bot` to `enum ContactType` in `packages/db/prisma/schema.prisma`
- [x] 1.2 Run `pnpm db:migrate` to generate the additive `ALTER TYPE ... ADD VALUE` migration; verify it is forward-only and non-destructive (no DB available in this env — migration `6_add_bot_contact_type` hand-authored as a pure additive `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'bot'`; Prisma client regenerated)
- [ ] 1.3 Note the migration in the PR description (PR not yet opened)

## 2. Shared contracts

- [x] 2.1 Add `'bot'` to the `ContactType` union in `packages/shared/src/types/index.ts`
- [x] 2.2 Add `'bot'` to the `ContactTypeZ` zod enum in `packages/shared/src/schemas/contact.ts`
- [x] 2.3 Run `pnpm typecheck` and fix any newly-surfaced exhaustiveness errors

## 3. Extraction pipeline

- [x] 3.1 Add `'bot'` to the regex candidate schema and the LLM output (`extractedContactSchema`) in `packages/agents/src/agents/ContactExtractor.ts`
- [x] 3.2 Update the `ContactExtractor` system prompt: classify `*_bot` handles as `type = 'bot'` WHEN context indicates advertising/business intake; otherwise keep rejecting them
- [x] 3.3 Extend `packages/agents/src/regex.ts` so a `_bot`-suffix handle with ad/business context surfaces a `bot` type candidate (role inference unchanged)
- [x] 3.4 Add `'bot'` case to `mapContactType()` in `apps/workers/src/queues/contact-extract.ts` (exhaustive switch) and set persistence `reachability = 'reachable_tg'` for `bot`

## 4. API & services

- [x] 4.1 Add a `*_bot` branch to `detectContactType()` in `apps/api/src/services/contacts.ts` (normalize to `@handle`, return `bot`)
- [x] 4.2 Update `reachabilityForType()` to return `'reachable_tg'` for `bot`
- [x] 4.3 Confirm `POST /contacts`, `POST /contacts/bulk`, `PATCH /contacts/:id` accept `bot` via the shared zod schema (no route change expected — verify)

## 5. Dispatch & send

- [x] 5.1 Exclude `type = 'bot'` from auto-selection in `apps/workers/src/queues/campaign-dispatcher.ts` (explicit `type` filter alongside `reachability: 'reachable_tg'`)
- [x] 5.2 Review `apps/workers/src/queues/tg-send.ts` profile-resolution branch for `bot` contacts reached manually; ensure no crash (resolve like a username if needed)

## 6. Web UI

- [x] 6.1 Add `'bot'` to the `ContactType` union in `apps/web/src/features/contacts/types.ts`
- [x] 6.2 Add `bot` to type options in `ContactsPage.vue`, `ContactCreateDialog.vue` (incl. auto path), and `ContactEditDrawer.vue`
- [x] 6.3 Add a distinct icon for `bot` in the `typeIcon` map in `ContactsPage.vue`

## 7. Tests

- [x] 7.1 Unit test: extractor classifies `@hadeout_bot` with "по рекламе" context as `type = 'bot'`
- [x] 7.2 Unit test: extractor rejects a `*_bot` handle with no ad/business context
- [x] 7.3 Unit test: `detectContactType('@x_bot')` and `t.me/x_bot` → `bot`; `reachabilityForType('bot') === 'reachable_tg'`
- [x] 7.4 Unit test: campaign dispatcher excludes `type = 'bot'` from auto-dispatch selection
- [x] 7.5 Run `pnpm typecheck && pnpm lint && pnpm test`

## 8. Docs

- [x] 8.1 Update the Contact model / contact types section in `DESIGN.md` to document the `bot` type and its dispatch exclusion
- [x] 8.2 Add an operator-visible entry to `CHANGELOG.md`
