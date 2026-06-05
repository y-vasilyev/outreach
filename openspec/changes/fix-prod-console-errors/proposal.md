## Why

Production (`outreach.su`) floods the browser console with three classes of error: an endless `wss://outreach.su/socket.io/` reconnect loop (realtime is dead — operators get no live inbox/suggestion/status updates), repeated `404` on `/api/conversations/:id/data-collection`, and `Failed to fetch dynamically imported module … MIME type "text/html"` that breaks lazy-loaded pages (e.g. Contacts). All three are deterministic config/code defects in this repo, not transient infra hiccups.

Root causes (verified):

1. **WebSocket** — `deploy/k8s/ingress.yaml` applies `nginx.ingress.kubernetes.io/rewrite-target: /$2` as an Ingress-wide annotation, so it rewrites **every** path. The `/socket.io` path has no `$2` capture group, so socket.io requests are rewritten to `/` and never reach the socket.io server. REST survives because `/api(/|$)(.*)` captures `$2`; the SPA catch-all `/()(.*)` was deliberately crafted with empty groups — `/socket.io` was the oversight.
2. **data-collection 404** — the `data_collection_hud` flag is off, and it is **not exposed in the public `GET /config` snapshot**, so the web `DataCollectionPanel` cannot gate its query. It fires for every visible conversation; the request is handled gracefully (`isFeatureOff`) but the browser still logs every network 404.
3. **Module MIME error** — after a web redeploy, a browser holding a stale `index.html` lazy-loads an old chunk hash that no longer exists in the pod. The container nginx `try_files $uri /index.html` answers the missing `/assets/*.js` with `index.html` (200, `text/html`), which the browser rejects as a module. There is no client recovery for failed dynamic imports.

## What Changes

- **Fix the production WS route**: give `/socket.io` correct routing in the Ingress so the global `rewrite-target` no longer strips it to `/` (dedicated path/group or a separate Ingress object without the rewrite annotation). Realtime reconnect loop stops.
- **Serve missing assets as 404, not the SPA shell**: container nginx (`infra/nginx.conf`) returns a real `404` for missing `/assets/*` instead of falling back to `index.html`, so a stale chunk fails with the correct status/MIME instead of a misleading `text/html` body.
- **Auto-recover stale SPA tabs**: the web app listens for failed dynamic imports (`vite:preloadError` / Vue Router `onError`) and performs a single guarded `location.reload()` to pull the fresh `index.html` — no reload loop.
- **Stop the data-collection 404 noise**: expose `data_collection_hud` in the public `/config` snapshot, mirror it in the web `AppFlags`, and gate the `DataCollectionPanel` query (`enabled`) on that flag so the request is never issued when the feature is off.

No behavior change to any feature that is currently working; this is a console-noise / realtime-availability hardening pass.

## Capabilities

### New Capabilities
- `production-edge-routing`: How the production edge (k8s Ingress) and the container nginx route requests — WebSocket upgrade reaches the socket.io server unrewritten, and missing static assets return a true `404` rather than the SPA `index.html` shell.
- `web-deploy-resilience`: How the web client survives a redeploy and flag state — it auto-recovers from a failed dynamic-import (stale chunk) with a single guarded reload, and it does not issue requests for capabilities the public flag snapshot reports as off.

### Modified Capabilities
- `runtime-feature-flags`: The public `GET /config` snapshot SHALL additionally expose the `data_collection_hud` flag so the web can gate client-side data-collection requests (it currently exposes only the five agency-rollout flags).

## Impact

- **Infra/deploy**: `deploy/k8s/ingress.yaml` (socket.io routing), `infra/nginx.conf` (`/assets/` 404 fallback). Requires re-applying the Ingress and rebuilding/redeploying the web image.
- **API**: `apps/api/src/routes/health.ts` (`/config` adds `dataCollectionHud`). No new route, no DB/schema change.
- **Web**: `apps/web/src/lib/config.ts` (`AppFlags` + default), `apps/web/src/features/inbox/DataCollectionPanel.vue` (gate query), plus a small app-bootstrap handler for `vite:preloadError` / router `onError` (`apps/web/src/main.ts` / `router/index.ts`).
- **Realtime**: restores all WS-delivered events (`message.new`, `suggestion.*`, `status.changed`, `data_collection.updated`, …) in production.
- No breaking changes; no secrets touched; `LOG_MESSAGE_BODIES` and CORS (`WEB_ORIGIN`) unaffected.
