#!/usr/bin/env bash
# Build → push → apply → set image → rollout, for the 3 outreach services.
# Adapted from the upstream talkmeter bundle that lived in this folder.
#
# Prereqs (one-time):
#   1. kubectl context points at the right cluster
#   2. `docker login cr.yandex` succeeded (or you have a credential helper)
#   3. CR_REGISTRY env var is set (Yandex Container Registry id, the long
#      `cr*` string). The placeholders in *-deployment.yaml are replaced
#      by `kubectl set image` below, so they never reach the cluster.
#   4. secrets.yaml has real values OR you've replaced it with an external
#      secret store (SealedSecrets / ExternalSecrets / `kubectl create
#      secret generic outreach-secrets --from-env-file=.env`).
#   5. cert-manager is installed in-cluster with a ClusterIssuer named
#      `letsencrypt` (referenced by ingress.yaml). If yours has a
#      different name, edit `cert-manager.io/cluster-issuer` in ingress.yaml.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${K8S_DIR:-$ROOT_DIR}"
NAMESPACE="${NAMESPACE:-outreach}"
TIMEOUT="${TIMEOUT:-180s}"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$ROOT_DIR/../.." && pwd)}"

# Yandex Container Registry. CR_REGISTRY is the registry id (the long
# `crp*` / `cr*` string in the YC console). CR_REPOSITORY is the logical
# prefix appended to every image — "outreach" gives you e.g.
# `cr.yandex/<id>/outreach-api`.
CR_REGISTRY="${CR_REGISTRY:-__paste-cr-registry-id__}"
CR_REPOSITORY="${CR_REPOSITORY:-outreach}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-cr.yandex/$CR_REGISTRY}"
API_IMAGE_NAME="${API_IMAGE_NAME:-$CR_REPOSITORY-api}"
WEB_IMAGE_NAME="${WEB_IMAGE_NAME:-$CR_REPOSITORY-web}"
WORKERS_IMAGE_NAME="${WORKERS_IMAGE_NAME:-$CR_REPOSITORY-workers}"

# Tag: short git sha + timestamp gives an immutable, sortable identifier
# even when multiple deploys happen on the same commit (the build args
# embedded in the web bundle may differ).
if [[ -n "${IMAGE_TAG:-}" ]]; then
  TAG="$IMAGE_TAG"
elif git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TAG="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
else
  TAG="$(date +%Y%m%d%H%M%S)"
fi

API_IMAGE="${IMAGE_REGISTRY%/}/$API_IMAGE_NAME"
WEB_IMAGE="${IMAGE_REGISTRY%/}/$WEB_IMAGE_NAME"
WORKERS_IMAGE="${IMAGE_REGISTRY%/}/$WORKERS_IMAGE_NAME"
API_IMAGE_WITH_TAG="$API_IMAGE:$TAG"
WEB_IMAGE_WITH_TAG="$WEB_IMAGE:$TAG"
WORKERS_IMAGE_WITH_TAG="$WORKERS_IMAGE:$TAG"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run] [--clean] [--skip-build]

Env overrides:
  K8S_DIR        Path to kustomize directory (default: $ROOT_DIR)
  PROJECT_ROOT   Path to repo root           (default: $PROJECT_ROOT)
  NAMESPACE      Kubernetes namespace        (default: outreach)
  TIMEOUT        Rollout wait timeout        (default: 180s)
  CR_REGISTRY    Yandex registry id          (REQUIRED unless overridden via IMAGE_REGISTRY)
  CR_REPOSITORY  Image name prefix           (default: outreach)
  IMAGE_REGISTRY Full registry prefix        (default: cr.yandex/<CR_REGISTRY>)
  IMAGE_TAG      Docker tag                  (default: git-sha+timestamp)
  PLATFORM       Docker build platform       (default: linux/amd64)

Flags:
  --dry-run     Render and validate manifests without building/pushing/applying
  --clean       Delete ALL existing resources in namespace before applying
                (use with care — wipes Deployments/Services/Ingresses/CMs/Secrets)
  --skip-build  Skip docker build+push; only apply manifests + set image
                to the supplied IMAGE_TAG (useful for re-deploying a known tag)

Examples:
  CR_REGISTRY=crpXXXXXXXX ./deploy.sh
  CR_REGISTRY=crpXXXXXXXX IMAGE_TAG=v0.1.0 ./deploy.sh
  ./deploy.sh --dry-run
  CR_REGISTRY=crpXXXXXXXX ./deploy.sh --skip-build  # roll the cluster to an existing tag
EOF
}

DRY_RUN=false
CLEAN=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --help|-h)    usage; exit 0 ;;
    --dry-run)    DRY_RUN=true ;;
    --clean)      CLEAN=true ;;
    --skip-build) SKIP_BUILD=true ;;
    *)            echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || {
  echo "Error: kubectl is not installed or not in PATH." >&2
  exit 1
}
if [[ "$SKIP_BUILD" != "true" && "$DRY_RUN" != "true" ]]; then
  command -v docker >/dev/null 2>&1 || {
    echo "Error: docker is not installed or not in PATH." >&2
    exit 1
  }
fi

echo "Using kubectl context: $(kubectl config current-context)"
echo "Deploying from: $K8S_DIR"
echo "Namespace:      $NAMESPACE"
echo "api image:      $API_IMAGE_WITH_TAG"
echo "web image:      $WEB_IMAGE_WITH_TAG"
echo "workers image:  $WORKERS_IMAGE_WITH_TAG"

if [[ "$CR_REGISTRY" == "__paste-cr-registry-id__" && "$DRY_RUN" != "true" ]]; then
  echo "Error: CR_REGISTRY is unset (still the placeholder). Set it in the env, e.g.:" >&2
  echo "  CR_REGISTRY=crpXXXXXXXX ./deploy.sh" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Running dry-run render/apply check (no build/push)..."
  kubectl apply -k "$K8S_DIR" --dry-run=client
  echo "Dry-run finished."
  exit 0
fi

PLATFORM="${PLATFORM:-linux/amd64}"

NO_CACHE_FLAG=""
if [[ "$CLEAN" == "true" ]]; then
  NO_CACHE_FLAG="--no-cache"
fi

if [[ "$SKIP_BUILD" != "true" ]]; then
  # All three builds use the same build context (the repo root) because the
  # Dockerfiles in infra/ copy pnpm workspace files from there. The web image
  # is the only one with a runtime-relevant bake-in: VITE_PUBLIC_API_URL is
  # NOT baked here because in the single-domain outreach.su deploy the web
  # talks to the API at same-origin `/api` (apps/web/src/lib/api.ts → fallback).
  echo "Building api image (platform: $PLATFORM)..."
  docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
    -t "$API_IMAGE_WITH_TAG" \
    -f "$PROJECT_ROOT/infra/Dockerfile.api" \
    "$PROJECT_ROOT"

  echo "Building web image (platform: $PLATFORM)..."
  docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
    -t "$WEB_IMAGE_WITH_TAG" \
    -f "$PROJECT_ROOT/infra/Dockerfile.web" \
    "$PROJECT_ROOT"

  echo "Building workers image (platform: $PLATFORM)..."
  docker build $NO_CACHE_FLAG --platform "$PLATFORM" \
    -t "$WORKERS_IMAGE_WITH_TAG" \
    -f "$PROJECT_ROOT/infra/Dockerfile.workers" \
    "$PROJECT_ROOT"

  # Push both the immutable tag and `:latest`. The kustomize manifests
  # reference `:latest` so a cold `kubectl apply -k` without the set-image
  # step below still pulls a working image; `set image` then pins each
  # Deployment to the immutable tag for this rollout.
  push_with_latest() {
    local image_with_tag="$1"
    local image="${image_with_tag%:*}"
    echo "Pushing $image_with_tag..."
    docker push "$image_with_tag"
    docker tag "$image_with_tag" "$image:latest"
    echo "Pushing $image:latest..."
    docker push "$image:latest"
  }
  push_with_latest "$API_IMAGE_WITH_TAG"
  push_with_latest "$WEB_IMAGE_WITH_TAG"
  push_with_latest "$WORKERS_IMAGE_WITH_TAG"
fi

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
kubectl -n "$NAMESPACE" set image deployment/api     api="$API_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/web     web="$WEB_IMAGE_WITH_TAG"
kubectl -n "$NAMESPACE" set image deployment/workers workers="$WORKERS_IMAGE_WITH_TAG"

echo "Waiting for deployments rollout..."
kubectl rollout status deployment/api     -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/web     -n "$NAMESPACE" --timeout="$TIMEOUT"
kubectl rollout status deployment/workers -n "$NAMESPACE" --timeout="$TIMEOUT"

echo "Current pods:"
kubectl get pods -n "$NAMESPACE" -o wide

echo "Current services and ingress:"
kubectl get svc -n "$NAMESPACE"
kubectl get ingress -n "$NAMESPACE"

echo "Deploy completed."
