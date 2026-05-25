# Outreach Kubernetes deploy

Kustomize bundle + thin shell script (`deploy.sh`) that builds and rolls
out the three outreach services:

| Service | Source | Image | Container port |
|---|---|---|---|
| `api` | `apps/api` (Fastify + Socket.IO) | `cr.yandex/<id>/outreach-api` | 4000 |
| `web` | `apps/web` (Vue 3 SPA, nginx) | `cr.yandex/<id>/outreach-web` | 80 |
| `workers` | `apps/workers` (BullMQ consumers) | `cr.yandex/<id>/outreach-workers` | — |

Domain: **outreach.su**. TLS via cert-manager (`ClusterIssuer: letsencrypt`).
Postgres, Redis and Qdrant are **external/managed** — only their connection
strings/keys live in the cluster (see `secrets.yaml`).

## Files

| File | Purpose |
|---|---|
| `namespace.yaml` | Creates `outreach` ns. |
| `configmap.yaml` | Non-secret env shared by api + workers (`NODE_ENV`, `WEB_ORIGIN`, `LOG_*`, etc.). |
| `secrets.yaml` | All secrets as placeholders (`__paste-...__`). Replace before first deploy or migrate to SealedSecrets / ExternalSecrets. |
| `api-deployment.yaml` | api Deployment + ClusterIP Service `:4000`. Probes hit `/health` (live) and `/health/deep` (ready — pings PG + Redis). |
| `web-deployment.yaml` | web Deployment + ClusterIP Service `:80`. Nginx serves the Vite bundle. |
| `workers-deployment.yaml` | workers Deployment. No HTTP/probes; `strategy: Recreate` to keep BullMQ single-writer per queue during rolls. |
| `ingress.yaml` | NGINX Ingress, single host. `/socket.io` → api, `/api(/\|$)(.*)` → api (prefix stripped via rewrite), `/` → web. |
| `kustomization.yaml` | Orchestration. |
| `deploy.sh` | Build → push → `kubectl apply -k` → `set image` → `rollout status`. |

## First deploy walkthrough

1. **Set the secrets.** Open `secrets.yaml` and replace every
   `__paste-...__` placeholder. The required keys (pod will crash-loop
   without them) are:
   - `DATABASE_URL` — external Postgres connection string
   - `REDIS_URL` — external Redis URL
   - `JWT_SECRET` — ≥ 16 bytes (recommend 32+); `openssl rand -base64 48`
   - `ENCRYPTION_KEY` — ≥ 10 bytes (recommend 32 hex); `openssl rand -hex 32`

   Optional (features fail closed when missing):
   - `TG_API_ID` / `TG_API_HASH` — Telegram MTProto creds
   - `OPENROUTER_API_KEY`, `YANDEX_*` — LLM/discovery providers
   - `SCRAPECREATORS_API_KEY` — channel scraping
   - `S3_*` — object storage (only used when `object_storage` flag is on)
   - `QDRANT_URL` / `QDRANT_API_KEY` — placeholders, not wired into code yet

   For prod, prefer **not** to commit `secrets.yaml` with real values:
   ```bash
   # one-time: drop the file from kustomize and create the Secret directly
   kubectl -n outreach create secret generic outreach-secrets \
     --from-env-file=./outreach.env
   # then remove `secrets.yaml` from kustomization.yaml resources
   ```

2. **Set your image registry.** `deploy.sh` reads `CR_REGISTRY` from env
   (Yandex Container Registry id) and the deployment YAMLs use
   `__paste-cr-registry-id__` as the bootstrap `:latest` source — those
   are overwritten by `kubectl set image` on every deploy, so they only
   matter if you ever do a bare `kubectl apply -k` without `deploy.sh`.
   If you want a clean apply too, sed those placeholders to your real id.

3. **Dry-run.**
   ```bash
   cd deploy/k8s
   ./deploy.sh --dry-run
   ```
   Renders kustomize and runs `kubectl apply --dry-run=client`. No build,
   no push, no apply.

4. **Deploy.**
   ```bash
   CR_REGISTRY=crpXXXXXXXX ./deploy.sh
   ```
   Builds 3 images, pushes both the immutable `<sha>-<ts>` tag and
   `:latest`, applies kustomize, pins each Deployment to the new tag,
   waits for rollout.

5. **Smoke checks.**
   ```bash
   kubectl -n outreach get pods
   kubectl -n outreach logs deploy/api | tail -50
   kubectl -n outreach exec deploy/api -- wget -qO- http://localhost:4000/health
   kubectl -n outreach exec deploy/api -- wget -qO- http://localhost:4000/health/deep
   curl -fsS https://outreach.su/api/health
   ```
   Open https://outreach.su in a browser, log in, watch DevTools →
   Network → WS for `/socket.io/` — it should upgrade and stay open
   (NGINX `proxy-read-timeout: 3600` keeps the long-lived connection
   alive).

## Re-deploying an existing tag

Roll the cluster to a tag that's already in the registry, without
rebuilding:

```bash
CR_REGISTRY=crpXXXXXXXX IMAGE_TAG=abc1234-20260525120000 ./deploy.sh --skip-build
```

## Cleanup / reset

```bash
./deploy.sh --clean
```

⚠ Deletes **all** Deployments/Services/Ingresses/ConfigMaps/Secrets in
the `outreach` namespace before applying. Use only in fresh-start
scenarios — your hand-edited Secret values are gone after this.

## External dependencies

| Dep | Wired via | Required? |
|---|---|---|
| Postgres (managed) | `DATABASE_URL` in Secret → Prisma | yes — pod crash-loops without it |
| Redis (managed) | `REDIS_URL` in Secret → BullMQ + feature-flag pub/sub | yes |
| Qdrant (managed) | `QDRANT_URL` / `QDRANT_API_KEY` placeholders | not consumed yet — placeholders for the matching/semantic-search work |
| cert-manager | `ClusterIssuer/letsencrypt` referenced by `ingress.yaml` | yes (TLS) |
| NGINX Ingress | `ingressClassName: nginx`, regex routing | yes |

## Architecture notes

- The web bundle is built **without** baking `VITE_PUBLIC_API_URL`, so it
  defaults to same-origin `/api` (see `apps/web/src/lib/api.ts`
  `getBaseUrl()`). That matches the single-host ingress and means a
  rebuild is not needed when DNS / domains change.
- The API mounts every route at root (`apps/api/src/index.ts` registers
  `healthRoutes`, `authRoutes`, … without a prefix). The `/api` prefix
  the web uses is stripped at the Ingress via
  `nginx.ingress.kubernetes.io/rewrite-target: /$2`. Don't add a
  `prefix:` block in Fastify and the rewrite — you'll end up with `/api/api/…`.
- Workers are pinned to `replicas: 1` + `strategy: Recreate` until the
  TG-send / ScrapeCreators / agent-run queue handlers are audited for
  idempotent concurrent execution. See the comment in
  `workers-deployment.yaml`.
- Outbound message bodies are never logged in prod
  (`LOG_MESSAGE_BODIES=false` in `configmap.yaml`, enforced via
  `packages/shared` redact()).
