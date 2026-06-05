/**
 * Stale-deploy recovery for lazy-loaded route chunks.
 *
 * After a web redeploy, a browser still holding the previous `index.html`
 * will try to import an old hashed chunk (e.g. `ContactsPage-XXXX.js`) that
 * no longer exists in the pod. The server answers 404 (see infra/nginx.conf
 * `/assets/` → =404) and the dynamic import rejects. Vite raises a
 * `vite:preloadError` window event; Vue Router surfaces the same as a
 * navigation error. In both cases the fix is to reload once and pick up the
 * fresh index.html + matching chunk hashes.
 *
 * Guarded so it fires at most once per page load: a `sessionStorage` sentinel
 * survives the reload itself, and a module-scoped boolean covers the case
 * where storage is unavailable (private mode, quota). The sentinel is cleared
 * on the next successful load (see `clearChunkReloadSentinel`) so a later
 * legitimate failure can recover again. If the chunk is genuinely gone the
 * sentinel stays set and we do NOT reload again — surfacing the failure
 * instead of looping.
 */
const SENTINEL = 'reloadedForChunkError';

let reloadedThisSession = false;

function alreadyReloaded(): boolean {
  if (reloadedThisSession) return true;
  try {
    return sessionStorage.getItem(SENTINEL) === '1';
  } catch {
    return false;
  }
}

function markReloaded(): void {
  reloadedThisSession = true;
  try {
    sessionStorage.setItem(SENTINEL, '1');
  } catch {
    /* storage unavailable — module-scoped flag still guards this tab */
  }
}

/**
 * Heuristic: does this error look like a failed dynamic-import / chunk load?
 * Covers Vite's preload error and the various browser messages for a module
 * fetch that resolved to a non-module (our 404 → index.html previously, now a
 * clean 404) or failed outright.
 */
export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return (
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /expected a javascript(-or-wasm)? module script/i.test(msg)
  );
}

/**
 * Reload the page once to recover from a stale chunk. No-op if we've already
 * reloaded this page load (prevents a loop when the chunk is truly missing).
 */
export function recoverFromChunkError(): void {
  if (alreadyReloaded()) return;
  markReloaded();
  window.location.reload();
}

/**
 * Call once on a successful app load so a future stale-deploy can recover
 * again. Leaves the module-scoped flag intact (this tab already reloaded if
 * it had to) but clears the cross-reload sentinel.
 */
export function clearChunkReloadSentinel(): void {
  try {
    sessionStorage.removeItem(SENTINEL);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Register the global `vite:preloadError` listener. Vite fires this on every
 * failed lazy import; we swallow the default (which would otherwise throw)
 * and reload once.
 */
export function installChunkReloadHandler(): void {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    recoverFromChunkError();
  });
}
