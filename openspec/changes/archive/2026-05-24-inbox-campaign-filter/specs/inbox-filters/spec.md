## ADDED Requirements

### Requirement: API conversation list filters

`GET /conversations` SHALL accept the optional query parameters `campaignId`, `status`, `mode`, `assignedOperatorId`, and `q` (free-text search), each independently optional, and SHALL return only conversations matching the conjunction of all provided filters. When no filter parameter is provided, the endpoint SHALL behave exactly as today and return the unfiltered list (capped by `limit`, default 100, ordered by `lastInboundAt desc, createdAt desc`). The shared `ConversationFiltersZ` schema SHALL normalize empty-string values (`""`) of `campaignId`, `status`, `mode`, and `assignedOperatorId` to `undefined` before validation, so that requests with empty form fields do not fail enum parsing.

#### Scenario: campaignId narrows the list to one campaign
- **WHEN** a client requests `GET /conversations?campaignId=<cid>`
- **THEN** the response contains only conversations whose `campaignId` equals `<cid>` (including those whose `campaign` relation matches), excludes conversations with `campaignId = NULL` and conversations in other campaigns, and preserves the existing ordering and per-row enrichment (`lastMessageText`, `lastMessageAt`, `pendingSuggestions`)

#### Scenario: Combined filters are conjunctive
- **WHEN** a client requests `GET /conversations?campaignId=<cid>&status=active&mode=manual`
- **THEN** the response contains only conversations that match all three filters simultaneously

#### Scenario: Unknown campaignId returns an empty list, not an error
- **WHEN** a client requests `GET /conversations?campaignId=<unknown-id>`
- **THEN** the API responds with HTTP 200 and an empty array; the request is not rejected and no other conversations leak through

#### Scenario: Empty filter values are treated as absent
- **WHEN** a client requests `GET /conversations?campaignId=&status=`
- **THEN** the request is parsed as if no `campaignId`/`status` was provided and the endpoint returns the full (unfiltered) list

### Requirement: Free-text search across contact and channel

`GET /conversations?q=<query>` SHALL match a conversation when its associated `contact.value`, the linked `channel.handle`, or the linked `channel.title` contains `<query>` case-insensitively. The query SHALL be combinable with the other filters (conjunctive). The shared `ConversationFiltersZ` schema SHALL trim `q`, treat whitespace-only and empty values as absent, and reject `q` longer than 200 characters with HTTP 400; longer queries are not a supported use case and the cap prevents pathological `ILIKE` scans.

#### Scenario: Search matches by channel handle
- **WHEN** the client requests `GET /conversations?q=acme`
- **THEN** conversations whose `channel.handle` contains `acme` (case-insensitively) are included; conversations without a linked channel but with `contact.value` matching `acme` are also included

#### Scenario: Search matches by channel title
- **WHEN** the client requests `GET /conversations?q=Coffee`
- **THEN** conversations whose `channel.title` contains `Coffee` (case-insensitively) are included

#### Scenario: Search combines with campaignId
- **WHEN** the client requests `GET /conversations?campaignId=<cid>&q=acme`
- **THEN** the response contains only conversations in campaign `<cid>` whose contact/channel matches `acme`

#### Scenario: Whitespace-only q is ignored
- **WHEN** the client requests `GET /conversations?q=%20%20`
- **THEN** the response is identical to a request without `q`

#### Scenario: Overlong q is rejected
- **WHEN** the client requests `GET /conversations?q=<201+ character string>`
- **THEN** the API responds with HTTP 400 (zod validation error) and does not execute the query

### Requirement: Inbox URL carries filter state

The web inbox route SHALL read filter state from URL query parameters and persist user-initiated filter changes back to the URL via `router.push` (creating a browser-history entry so back/forward navigates between filter states), and SHALL use `router.replace` only for non-user navigation such as auto-selecting the first conversation in the filtered list. Page reloads and shared links SHALL restore the same filtered view. Supported parameters: `campaignId`, `status`, `mode`, `assignedOperatorId`, `q`. The selected conversation continues to be encoded as the path segment (`/inbox/:conversationId`); navigating between conversations SHALL preserve the current `route.query`.

#### Scenario: Reload preserves the filter
- **WHEN** an operator selects campaign `<cid>` in the inbox filter UI and reloads the page
- **THEN** after reload the inbox shows only conversations from campaign `<cid>` and the filter UI reflects `<cid>` as the active selection

#### Scenario: Clearing a filter updates the URL and creates history
- **WHEN** an operator clears the campaign filter
- **THEN** the URL no longer contains `campaignId`, the conversation list reflects the un-narrowed scope, and the browser back button returns to the previously filtered view (because the filter change was committed via `router.push`)

#### Scenario: Auto-selecting first conversation respects the filter and does not pollute history
- **WHEN** an operator opens `/inbox?campaignId=<cid>` without a `:conversationId` and the filtered list is non-empty
- **THEN** the UI navigates to the first conversation of the filtered list (not the first conversation overall) via `router.replace`, so back/forward navigation skips the auto-selected entry; when the filtered list is empty, no auto-navigation happens and an empty state is shown

#### Scenario: Clicking a conversation preserves active filters
- **WHEN** an operator clicks a conversation in the filtered list
- **THEN** the URL becomes `/inbox/<conversationId>?<same-query-as-before>`; the active filters are preserved across the selection change

#### Scenario: Selected conversation outside the filtered list still renders
- **WHEN** an operator applies a filter that excludes the currently selected `:conversationId`
- **THEN** the right-hand conversation panel continues to render the selected conversation (driven by `GET /conversations/:id`, not by the filtered list), and the left-hand list shows only the filtered results without that conversation

### Requirement: Campaign detail links to its inbox

The campaign detail page SHALL expose a primary action that navigates to `/inbox?campaignId=<this-campaign-id>` so the operator can jump from a campaign into its filtered inbox in one click.

#### Scenario: Operator opens campaign inbox from the campaign page
- **WHEN** the operator clicks the "Open inbox" action on a campaign detail page
- **THEN** the operator is navigated to `/inbox?campaignId=<id>`, the inbox loads with the campaign filter pre-applied, and the campaign name is visible in the active-filter UI

### Requirement: Counts reflect the filtered scope

The inbox header counter and the `ConversationList` quick-filter tabs (`all`, `ai`, `op`, …) SHALL compute their counts over the currently filtered list, not over the global set, so the visible totals match what the operator sees.

#### Scenario: Filter narrows the displayed totals
- **WHEN** the operator applies `campaignId=<cid>`
- **THEN** the "Inbox <count>" header and every quick-filter tab count reflect only conversations in campaign `<cid>`

### Requirement: Authorization is unchanged by filters

The conversation list endpoint and the inbox UI SHALL apply the same role gate as today (`admin`, `operator`, `viewer`) regardless of which filters are present. Filters SHALL NOT be used as a privilege boundary — a user who can read `GET /conversations` without filters can read it with any filter combination.

#### Scenario: Viewer can filter
- **WHEN** a viewer-role user requests `GET /conversations?campaignId=<cid>`
- **THEN** the endpoint responds with HTTP 200 and the filtered list (same shape as for operators/admins)

### Requirement: assignedOperatorId filter is URL-only in v1

The `assignedOperatorId` filter SHALL be accepted by the API (already true today via `ConversationFiltersZ`) and SHALL be honored when present in the URL (deep-link / saved link use case), but the inbox filter UI in this change SHALL NOT expose a picker for it. A picker requires listing operator users, and the current `GET /users` endpoint is restricted to the `admin` role, while the inbox is used by operators and viewers as well. A future change can introduce a role-safe operator-lookup endpoint and add the UI picker.

#### Scenario: Deep link by operator id is honored
- **WHEN** a user opens `/inbox?assignedOperatorId=<oid>`
- **THEN** the API returns only conversations assigned to that operator and the inbox renders them; no UI picker for `assignedOperatorId` is shown
