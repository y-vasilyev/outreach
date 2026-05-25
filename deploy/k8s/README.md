# Talkmeter Kubernetes deploy

Kustomize bundle + thin shell script (`deploy.sh`) that builds and rolls
out the five service images: `backend` (.NET 10 + Orleans), `admin`
(Vue SPA), `webapp` (PWA bundle on talkmeter.ru/feedback path), `pwa`
(standalone PWA on app.talkmeter.ru), `mini-app` (Telegram WebApp on
talkmeter.ru/mini-app).

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | Creates `talkmeter` ns. |
| `configmap.yaml` | Non-secret backend env (.NET key style: `Database__ApplyMigrationsOnStart`, `Cors__AllowedOrigins__0`, etc.). |
| `secrets.yaml` | Backend secrets (.NET key style: `Database__ConnectionString`, `Jwt__Secret`, `Telegram__BotToken`, `PwaPush__*`, `Admin__*`). **Real values committed = leak via git history; rotate.** |
| `backend-deployment.yaml` | API + silo co-host. Probes hit `/health/live` (no-check) and `/health/ready` (Postgres). |
| `admin-deployment.yaml` | Vue admin SPA. |
| `webapp-deployment.yaml` | Legacy PWA mount (talkmeter.ru/feedback). |
| `pwa-deployment.yaml` | Standalone PWA (app.talkmeter.ru). |
| `mini-app-deployment.yaml` | Telegram WebApp (talkmeter.ru/mini-app). |
| `ingress.yaml` | NGINX routes + TLS. WebSocket-friendly (`proxy-read-timeout: 3600`). Routes `/ws/user-events` and `/ws/speaker-dashboard` to backend. |
| `kustomization.yaml` | Orchestration. |
| `deploy.sh` | Build → push → `kubectl apply -k` → `set image` → rollout status. |
| `scripts/generate-vapid-keys.sh` | One-shot VAPID key pair generator (P-256, base64url, format expected by `PwaPushClient.CreateEcdsa`). |

## First deploy walkthrough

1. **Generate VAPID keys** (one-time):
   ```bash
   ./scripts/generate-vapid-keys.sh
   ```
   Copy the printed `PwaPush__PublicKey` / `PwaPush__PrivateKey` values
   into `secrets.yaml` (replace the `__paste-vapid-...__` placeholders).
   The same `PublicKey` is exposed to PWA via
   `GET /api/v1/users/me/push-public-key` — rotating it invalidates all
   existing browser subscriptions.

2. **Set the rest of the secrets** (`Jwt__Secret`, `Admin__Password`, and
   verify `Database__ConnectionString` / `Telegram__BotToken`).

3. **Dry-run** the bundle:
   ```bash
   ./deploy.sh --dry-run
   ```
   Renders kustomize + client-side validation, no docker/kubectl writes.

4. **Deploy**:
   ```bash
   ./deploy.sh
   ```
   Builds + pushes 5 images, applies kustomize, sets new tags on the
   five Deployments, waits for rollout.

5. **Smoke checks**:
   ```bash
   kubectl -n talkmeter logs deploy/backend | grep -E "Started|Reminders ensured"
   curl -fsS https://talkmeter.ru/health/live
   curl -fsS https://talkmeter.ru/health/ready
   ```
   In a browser, open the PWA, log in, watch DevTools → Network → WS:
   `wss://talkmeter.ru/ws/user-events/{userId}?access_token=…` should
   stay open without 1006 close (NGINX `proxy-read-timeout: 3600` keeps
   the long-lived connection alive).

## Rolling VAPID keys

VAPID rotation is a coordinated change — all browsers' existing
subscriptions become invalid because the `applicationServerKey` they
were created with no longer matches.

1. Generate new key pair (`./scripts/generate-vapid-keys.sh`).
2. Update `PwaPush__PublicKey` + `PwaPush__PrivateKey` in `secrets.yaml`
   (or your secret store).
3. `kubectl rollout restart deploy/backend -n talkmeter`.
4. PWA clients on next page load fetch the new public key and
   re-subscribe automatically (`pushManager.getSubscription()` → fall
   through to `subscribe()` because old subscription's `applicationServerKey`
   doesn't match). Old subscriptions linger as dead `pwa_push_subscriptions`
   rows until the dispatcher tries them and gets 410, which marks them
   `disabled_at` (see `IPwaPushSubscriptionRepository.DisableByEndpointAsync`).

## Backend env-var reference

ASP.NET Core reads env-vars where `__` separates configuration sections
(`Database:ConnectionString` ↔ `Database__ConnectionString`). Backend
binds these in `Feedback.Api/Program.cs`. Anything else — including
all Node.js-era keys — is silently ignored.

| Env (configmap or secret) | Source | Notes |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` / `ASPNETCORE_URLS` | configmap | Hosting. |
| `DOTNET_GCServer` / `DOTNET_TieredPGO` | configmap | Runtime tuning. |
| `Database__ConnectionString` | **secret** | EF Core + Orleans clustering / storage / reminders. |
| `Database__ApplyMigrationsOnStart` | configmap | EF auto-migrate on boot. |
| `Jwt__Secret` | **secret** | ≥ 32 bytes. Access + refresh token signing. |
| `Telegram__BotToken` | **secret** | Bot API send + webhook verify. |
| `PwaPush__Subject` | **secret** | `mailto:` or URL identifying app contact. |
| `PwaPush__PublicKey` | **secret** | base64url, P-256 uncompressed (65 bytes). |
| `PwaPush__PrivateKey` | **secret** | base64url, P-256 scalar (32 bytes). |
| `PwaPush__TtlSeconds` | configmap | Push service TTL header. |
| `Admin__Email` / `Admin__Password` | **secret** | Admin seeder bootstrap. |
| `Cors__AllowedOrigins__0..N` | configmap | Exact origins; no wildcards with credentials. |
| `NotificationDispatch__TalkReminderLeadMinutes` | configmap | Talk reminder scheduler. |

## Architecture notes

- Notification pipeline (`NotificationBroadcastGrain`, observer-pattern
  WS): see `docs/notifications-dispatch.md`.
- Multi-silo Orleans (`replicas > 1`) is **not** wired in this bundle.
  When you go HA: convert `backend-deployment` to `StatefulSet`, add a
  headless service exposing silo port 11111 + gateway 30000, set
  `podAntiAffinity`. The application code is already cross-silo-safe
  (grain-observer fan-out, no MemoryStreams for inbox events).
