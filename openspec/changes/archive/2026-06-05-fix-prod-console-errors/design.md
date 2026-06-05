## Context

`outreach.su` runs as a single-host k8s deployment: an nginx Ingress terminates TLS and routes to three services (`api:4000`, `web:80`, workers). The `web` pod is a static nginx (`infra/nginx.conf`) serving the Vite-built Vue SPA; the `api` pod is Fastify + socket.io. The console errors reported in production are all reproducible from the committed config:

- `deploy/k8s/ingress.yaml` sets `rewrite-target: /$2` and `use-regex: true` as Ingress-scoped annotations. In nginx-ingress these apply to **every** path rule in the object. `/api(/|$)(.*)` and the SPA `/()(.*)` both supply a `$2` group; `/socket.io` does not, so its rewrite resolves to `/` and the socket.io endpoint is unreachable → endless client reconnect.
- `infra/nginx.conf` has a single `location / { try_files $uri /index.html; }`. A missing hashed asset is therefore answered with `index.html` (200, `text/html`), which the browser rejects when it was requested as a module — the `ContactsPage` failure.
- `data_collection_hud` is off and absent from the `/config` snapshot (`apps/api/src/routes/health.ts`), so `DataCollectionPanel.vue` cannot gate its `useQuery`; it fires per conversation and logs a network 404 even though `isFeatureOff` swallows it in app code.

These are independent fixes that share one theme (production console health) and one deploy boundary, so they ride together.

## Goals / Non-Goals

**Goals:**
- Restore realtime WS in production with no client change (Ingress-only fix).
- Eliminate the misleading `text/html` MIME error for missing chunks and let stale tabs self-heal after a deploy.
- Remove the `data-collection` 404 noise by not issuing the request when the feature is off.
- Keep every currently-working surface byte-for-byte unchanged (all flags stay off by default).

**Non-Goals:**
- No change to socket.io auth, transports, or the app-level realtime event contract.
- No atomic/multi-version asset-retention strategy (keeping old chunks across deploys). The reload-on-preload-error path is sufficient and far simpler.
- No new feature flag, DB migration, or schema change.
- Not turning `data_collection_hud` on — that stays an operator decision in Settings → Features.

## Decisions

### 1. Fix the socket.io route at the Ingress, not in app code

The socket.io path is broken purely by the shared `rewrite-target`. Two viable shapes:

- **(A) Capture-group the path** so `$2` reproduces the full socket.io path, mirroring the SPA `/()(.*)` trick: `path: /(socket\.io)(.*)` would set `$2` to everything after `socket.io`, which **drops** the `socket.io` segment — wrong. To preserve it we'd need `rewrite-target` to be path-specific, which Ingress annotations don't allow.
- **(B) Move socket.io into its own Ingress object** (same host/class, `tls` shared) **without** the `rewrite-target`/`use-regex` annotations. nginx-ingress merges rules across Ingress objects per host; the socket.io object keeps a plain `path: /socket.io` (prefix) with no rewrite, so the path reaches the api untouched. The long-timeout annotations (`proxy-read-timeout`/`proxy-send-timeout: 3600`) move onto this object.

**Chosen: (B).** It is the only option that preserves `/socket.io` without contorting capture groups, and it isolates WS routing from the REST rewrite so a future REST-routing change can't silently re-break WS. Trade-off: two Ingress objects for one host (slightly more YAML); acceptable and well-commented.

### 2. Container nginx returns 404 for missing assets

Add a dedicated `location /assets/ { try_files $uri =404; }` ahead of the SPA fallback in `infra/nginx.conf`. Vite emits all hashed bundles under `/assets/`, so this cleanly separates "immutable hashed asset" (must exist or 404) from "app route" (fall back to `index.html`). Also add long-cache `Cache-Control: immutable` for `/assets/` since the names are content-hashed (nice-to-have, not required by spec). This makes a stale-chunk request fail with the correct status instead of a deceptive HTML 200, which is also the precondition that makes the client preload-error event fire reliably.

### 3. Client self-heals stale tabs via a single guarded reload

Vite dispatches `vite:preloadError` on `window` when a dynamic import fails; Vue Router surfaces the same as a navigation error. Register a handler at app bootstrap that, guarded by a `sessionStorage` sentinel (e.g. `reloadedForChunkError`), calls `location.reload()` once and clears the sentinel on the next successful load. This recovers a user who held the page across a redeploy without risking a reload loop when the chunk is genuinely gone.

Alternative considered: a service worker / build-time manifest diff to keep old chunks. Rejected as heavy for a single-operator admin app; reload-once is the standard, low-risk SPA pattern.

### 4. Gate the HUD query on the public flag snapshot

Add `data_collection_hud → dataCollectionHud` to the `/config` snapshot (`health.ts`) and to web `AppFlags`/`DEFAULT_FLAGS` (`lib/config.ts`, default `false`). In `DataCollectionPanel.vue`, read `useFlags()` and set `useQuery({ enabled: () => flags.value.dataCollectionHud, ... })`. With `enabled` false the query never runs, so no request and no 404. The existing `isFeatureOff` retry/guard stays as defense-in-depth for the race where a flag flips between `/config` fetch and navigation.

## Risks / Trade-offs

- **[Two Ingress objects could conflict on path precedence]** → socket.io stays on its own exact prefix `/socket.io`; REST/SPA remain in the original object. nginx-ingress orders by path specificity, and `/socket.io` is more specific than `/`, so it wins. Verify post-apply with a real `wss://` handshake.
- **[Reload-once could still loop if `sessionStorage` is unavailable]** → guard also checks a module-scoped boolean so a single tab won't double-reload even without storage; if storage throws, fall back to "reload at most once per tab session."
- **[`/assets/` 404 surfaces real deploy gaps as user-visible failures]** → that is the intended, honest behavior; combined with the client reload, the common stale-tab case auto-recovers and only a genuinely broken deploy reaches the user.
- **[Adding a flag to `/config` is a contract change]** → it is additive (new boolean field); existing consumers ignore unknown/extra fields and `DEFAULT_FLAGS` keeps it off until the snapshot resolves.

## Migration Plan

1. Merge code + config. Build and push the new `web` image (carries the nginx `/assets/` change and the client reload/flag-gate).
2. `kubectl apply` the Ingress changes (split socket.io object). Re-deploy `api` (carries the `/config` field) and `web`.
3. Verify in prod: (a) a `wss://outreach.su/socket.io/` connection established with no reconnect spam; (b) requesting a non-existent `/assets/foo.js` returns 404 (not HTML); (c) no `data-collection` 404 in console with the flag off; (d) toggling `data_collection_hud` on makes the HUD query fire and render.
4. **Rollback**: revert the Ingress object split (single object) and roll back the `web`/`api` images. Each fix is independent, so any one can be reverted without the others.

## Open Questions

- Does the cluster's nginx-ingress version honor per-object annotations as assumed (it does for the supported `kubernetes/ingress-nginx`)? Confirm the controller flavor before apply.
- Should `/config` gain the remaining non-agency flags too, or only `data_collection_hud` now? This change adds only what the noise requires; broader exposure can be a follow-up.
