## 1. Fix production WebSocket routing (Ingress)

- [x] 1.1 In `deploy/k8s/ingress.yaml`, remove the `/socket.io` path from the rewrite-bearing Ingress object and move it into a dedicated Ingress object (same host `outreach.su`, same `ingressClassName: nginx`, shared `tls`/`secretName`) that does NOT set `rewrite-target` or `use-regex`, keeping `proxy-read-timeout`/`proxy-send-timeout: "3600"`; route `path: /socket.io` (Prefix) to `api:4000`.
- [x] 1.2 Confirm the REST `/api(/|$)(.*)` and SPA `/()(.*)` paths still resolve correctly in the original object after socket.io is split out (no `$2`-empty path remains).
- [x] 1.3 Update the header comment in `ingress.yaml` to document why socket.io lives in its own annotation-free object (global `rewrite-target` would strip it to `/`).

## 2. Serve missing assets as 404 (container nginx)

- [x] 2.1 In `infra/nginx.conf`, add `location /assets/ { try_files $uri =404; }` BEFORE the `location /` SPA fallback so missing hashed chunks return 404 instead of `index.html`.
- [x] 2.2 Add `Cache-Control: public, max-age=31536000, immutable` for `/assets/` (content-hashed names) — optional hardening, keep SPA `index.html` uncached.
- [x] 2.3 Verify `try_files $uri /index.html` still covers application/deep-link routes outside `/assets/`.

## 3. Auto-recover stale SPA tabs (web client)

- [x] 3.1 In the web app bootstrap (`apps/web/src/main.ts`), add a `window.addEventListener('vite:preloadError', ...)` handler that performs a single guarded `location.reload()` using a `sessionStorage` sentinel plus a module-scoped boolean fallback.
- [x] 3.2 Add a Vue Router `router.onError(...)` handler (`apps/web/src/router/index.ts`) that triggers the same guarded reload for dynamic-import/module-load navigation failures.
- [x] 3.3 Clear the reload sentinel on the next successful app load so a later legitimate failure can recover again, and ensure no reload loop when the chunk is genuinely gone.

## 4. Stop the data-collection 404 noise (flag in /config + gated query)

- [x] 4.1 In `apps/api/src/routes/health.ts`, add `dataCollectionHud: snap.data_collection_hud` to the `/config` `flags` object.
- [x] 4.2 In `apps/web/src/lib/config.ts`, add `dataCollectionHud: boolean` to `AppFlags`, `ConfigResponse`, and `DEFAULT_FLAGS` (default `false`).
- [x] 4.3 In `apps/web/src/features/inbox/DataCollectionPanel.vue`, read `useFlags()` and set the `useQuery` `enabled: () => flags.value.dataCollectionHud` so no request fires when the flag is off; keep the existing `isFeatureOff` guard as defense-in-depth.

## 5. Tests & verification

- [x] 5.1 Update/extend the data-collection HUD test (`apps/api/src/routes/__tests__/data-collection-hud.test.ts`) and/or a `/config` test to assert the snapshot includes `dataCollectionHud` reflecting the flag state.
- [x] 5.2 Add/adjust a web unit test asserting `DataCollectionPanel` issues no request when `dataCollectionHud` is false and queries when true (mirror `DiscoveryPage` `useFlags` mock pattern).
- [x] 5.3 Run `pnpm typecheck && pnpm lint && pnpm test`; add a CHANGELOG entry for the operator-visible fixes (realtime restored, no console errors).
- [ ] 5.4 Post-deploy manual verification per design Migration Plan: live `wss://outreach.su/socket.io/` handshake succeeds with no reconnect spam; missing `/assets/*.js` returns 404; no `data-collection` 404 with flag off; HUD renders when flag on.
