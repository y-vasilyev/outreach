#!/usr/bin/env bash
set -euo pipefail

VITE_TELEGRAM_BOT_USERNAME="cdfst_fdbk_visitor_bot"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${K8S_DIR:-$ROOT_DIR}"
NAMESPACE="${NAMESPACE:-talkmeter}"
TIMEOUT="${TIMEOUT:-180s}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$ROOT_DIR/../.." && pwd)}"

CR_REGISTRY="${CR_REGISTRY:-crp6nndlr4elmeapikta}"
CR_REPOSITORY="${CR_REPOSITORY:-talkmeter}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-cr.yandex/$CR_REGISTRY}"
BACKEND_IMAGE_NAME="${BACKEND_IMAGE_NAME:-$CR_REPOSITORY-backend}"
ADMIN_IMAGE_NAME="${ADMIN_IMAGE_NAME:-$CR_REPOSITORY-admin}"
# webapp = legacy PWA mount under talkmeter.ru/{feedback,speaker-dashboard,pc}
# pwa    = standalone PWA on app.talkmeter.ru
# mini-app = Telegram WebApp build on talkmeter.ru/mini-app
# webapp + pwa share the same Dockerfile (PWA bundle), mini-app has its own.
WEBAPP_IMAGE_NAME="${WEBAPP_IMAGE_NAME:-$CR_REPOSITORY-webapp}"
PWA_IMAGE_NAME="${PWA_IMAGE_NAME:-$CR_REPOSITORY-pwa}"
MINIAPP_IMAGE_NAME="${MINIAPP_IMAGE_NAME:-$CR_REPOSITORY-mini-app}"

if [[ -n "${IMAGE_TAG:-}" ]]; then
  TAG="$IMAGE_TAG"
elif git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TAG="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
else
  TAG="$(date +%Y%m%d%H%M%S)"
fi

prefix_image() {
  local registry="$1"
  local image="$2"
  if [[ -z "$registry" ]]; then
    echo "$image"
  else
    echo "${registry%/}/$image"
  fi
}

BACKEND_IMAGE="$(prefix_image "$IMAGE_REGISTRY" "$BACKEND_IMAGE_NAME")"
ADMIN_IMAGE="$(prefix_image "$IMAGE_REGISTRY" "$ADMIN_IMAGE_NAME")"
WEBAPP_IMAGE="$(prefix_image "$IMAGE_REGISTRY" "$WEBAPP_IMAGE_NAME")"
PWA_IMAGE="$(prefix_image "$IMAGE_REGISTRY" "$PWA_IMAGE_NAME")"
MINIAPP_IMAGE="$(prefix_image "$IMAGE_REGISTRY" "$MINIAPP_IMAGE_NAME")"
BACKEND_IMAGE_WITH_TAG="${BACKEND_IMAGE}:$TAG"
ADMIN_IMAGE_WITH_TAG="${ADMIN_IMAGE}:$TAG"
WEBAPP_IMAGE_WITH_TAG="${WEBAPP_IMAGE}:$TAG"
PWA_IMAGE_WITH_TAG="${PWA_IMAGE}:$TAG"
MINIAPP_IMAGE_WITH_TAG="${MINIAPP_IMAGE}:$TAG"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--clean]

Env overrides:
  K8S_DIR    Path to kustomize directory (default: $ROOT_DIR)
  PROJECT_ROOT Path to repo root (default: $PROJECT_ROOT)
  NAMESPACE  Kubernetes namespace (default: talkmeter)
  TIMEOUT    Rollout wait timeout (default: 180s)
  CR_REGISTRY Yandex registry id (default: crp6nndlr4elmeapikta)
  CR_REPOSITORY Base repository name (default: talkmeter)
  IMAGE_REGISTRY Registry prefix (default: cr.yandex/<CR_REGISTRY>)
  BACKEND_IMAGE_NAME Backend image name (default: <CR_REPOSITORY>-backend)
  ADMIN_IMAGE_NAME   Admin image name (default: <CR_REPOSITORY>-admin)
  WEBAPP_IMAGE_NAME  Webapp image name (default: <CR_REPOSITORY>-webapp)
  PWA_IMAGE_NAME     Standalone PWA image (default: <CR_REPOSITORY>-pwa)
  MINIAPP_IMAGE_NAME Telegram WebApp image (default: <CR_REPOSITORY>-mini-app)
  IMAGE_TAG  Docker tag to use (default: git-sha+timestamp or timestamp)
  PLATFORM   Docker build platform (default: linux/amd64)

Flags:
  --dry-run  Render and validate manifests without building/pushing/applying
  --clean    Delete ALL existing resources in namespace before applying (removes old services)

Examples:
  ./deploy.sh
  ./deploy.sh --clean
  IMAGE_TAG=v2.3.0 ./deploy.sh
  CR_REGISTRY=crp6nndlr4elmeapikta CR_REPOSITORY=talkmeter ./deploy.sh
  NAMESPACE=talkmeter TIMEOUT=300s ./deploy.sh
  ./deploy.sh --dry-run
EOF
}

DRY_RUN=false
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=true ;;
    --clean)   CLEAN=true ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || {
  echo "Error: kubectl is not installed or not in PATH." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "Error: docker is not installed or not in PATH." >&2
  exit 1
}

echo "Using kubectl context: $(kubectl config current-context)"
echo "Deploying from: $K8S_DIR"
echo "Namespace: $NAMESPACE"
echo "Backend image:  $BACKEND_IMAGE_WITH_TAG"
echo "Admin image:    $ADMIN_IMAGE_WITH_TAG"
echo "Webapp image:   $WEBAPP_IMAGE_WITH_TAG"
echo "PWA image:      $PWA_IMAGE_WITH_TAG"
echo "Mini-app image: $MINIAPP_IMAGE_WITH_TAG"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Running dry-run render/apply check (no build/push)..."
  kubectl apply -k "$K8S_DIR" --dry-run=client
  echo "Dry-run finished."
  exit 0
fi

PLATFORM="${PLATFORM:-linux/amd64}"

# Vite bakes VITE_* env vars into the JS bundle at build time, so anything we
# need on the PWA login screen (e.g. the Telegram Login Widget bot username)
# must be passed as a Docker build-arg, not via runtime ConfigMap. Empty value
# is allowed (the widget block hides itself), but warn loudly so it's not a
# silent regression — the most common deploy mistake we hit.
TELEGRAM_BOT_USERNAME="${VITE_TELEGRAM_BOT_USERNAME:-}"
if [[ -z "$TELEGRAM_BOT_USERNAME" ]]; then
  echo "Warning: VITE_TELEGRAM_BOT_USERNAME is empty — Telegram login widget will be hidden in PWA." >&2
fi

# Admin "copy link" / "QR" buttons build PWA URLs (invite, per-talk feedback,
# per-room feedback) via pwaBaseUrl(). The admin runs at the apex talkmeter.ru,
# so without this baked value pwaBaseUrl() falls back to the admin origin and
# emits broken links like https://talkmeter.ru/r/... instead of the PWA's
# https://app.talkmeter.ru/r/... — pass it as a build-arg (matching CI).
PWA_BASE_URL="${VITE_PWA_BASE_URL:-https://app.talkmeter.ru}"

NO_CACHE_FLAG=""
if [[ "$CLEAN" == "true" ]]; then
  NO_CACHE_FLAG="--no-cache"
fi

echo "Building backend image (platform: $PLATFORM)..."
docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
  -t "$BACKEND_IMAGE_WITH_TAG" \
  -f "$PROJECT_ROOT/backend/Feedback.Api/Dockerfile" \
  "$PROJECT_ROOT/backend"

echo "Building admin image (platform: $PLATFORM)..."
docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
  --build-arg VITE_PWA_BASE_URL="$PWA_BASE_URL" \
  -t "$ADMIN_IMAGE_WITH_TAG" "$PROJECT_ROOT/admin"

echo "Building webapp (PWA bundle for talkmeter.ru/feedback) image..."
docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
  --build-arg VITE_TELEGRAM_BOT_USERNAME="$TELEGRAM_BOT_USERNAME" \
  -t "$WEBAPP_IMAGE_WITH_TAG" \
  -f "$PROJECT_ROOT/webapp/packages/pwa/Dockerfile" \
  "$PROJECT_ROOT/webapp"

echo "Building standalone PWA (app.talkmeter.ru) image..."
docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
  --build-arg VITE_TELEGRAM_BOT_USERNAME="$TELEGRAM_BOT_USERNAME" \
  -t "$PWA_IMAGE_WITH_TAG" \
  -f "$PROJECT_ROOT/webapp/packages/pwa/Dockerfile" \
  "$PROJECT_ROOT/webapp"

echo "Building Telegram mini-app (talkmeter.ru/mini-app) image..."
docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
  -t "$MINIAPP_IMAGE_WITH_TAG" \
  -f "$PROJECT_ROOT/webapp/packages/mini-app/Dockerfile" \
  "$PROJECT_ROOT/webapp"

# Tag every image also as :latest and push both. The k8s manifests
# reference :latest by default; the immutable date-sha tag is what the
# `kubectl set image` step below pins to. Pushing :latest gives a sane
# fallback when someone runs `kubectl apply -k` without the set-image
# step (e.g. CI bootstrapping) — the deployment then pulls the most
# recent build instead of failing with ImagePullBackOff.
push_with_latest() {
  local image_with_tag="$1"
  local image="${image_with_tag%:*}"
  echo "Pushing $image_with_tag..."
  docker push "$image_with_tag"
  docker tag "$image_with_tag" "$image:latest"
  echo "Pushing $image:latest..."
  docker push "$image:latest"
}

push_with_latest "$BACKEND_IMAGE_WITH_TAG"
push_with_latest "$ADMIN_IMAGE_WITH_TAG"
push_with_latest "$WEBAPP_IMAGE_WITH_TAG"
push_with_latest "$PWA_IMAGE_WITH_TAG"
push_with_latest "$MINIAPP_IMAGE_WITH_TAG"

if [[ "$CLEAN" == "true" ]]; then
  echo "Cleaning up ALL old resources in namespace $NAMESPACE..."
  kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"
  kubectl delete deployments,services,ingresses,configmaps,secrets,statefulsets,daemonsets,jobs,cronjobs \
    --all -n "$NAMESPACE" --ignore-not-found
  echo "Cleanup complete."
fi

echo "Applying manifests..."
kubectl apply -k "$K8S_DIR"

echo "Updating deployment images..."
kubectl -n "$NAMESPACE" set image deployment/backend  backend="$BACKEND_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/admin    admin="$ADMIN_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/webapp   webapp="$WEBAPP_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/pwa      pwa="$PWA_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/mini-app mini-app="$MINIAPP_IMAGE_WITH_TAG"

echo "Waiting for deployments rollout..."
kubectl rollout status deployment/backend  -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/admin    -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/webapp   -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/pwa      -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/mini-app -n "$NAMESPACE" --timeout="$TIMEOUT"

echo "Current pods:"
kubectl get pods -n "$NAMESPACE" -o wide

echo "Current services and ingress:"
kubectl get svc -n "$NAMESPACE"
kubectl get ingress -n "$NAMESPACE"

echo "Deploy completed."
