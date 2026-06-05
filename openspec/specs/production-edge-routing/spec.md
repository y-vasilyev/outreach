## Purpose

The production edge (k8s Ingress for `outreach.su`) routes browser traffic to the API and web services. This capability ensures the socket.io WebSocket upgrade reaches the API unrewritten, REST and SPA routing stay correct, and the web container returns `404` for missing static assets instead of falling back to the SPA shell.
## Requirements
### Requirement: WebSocket upgrade reaches the socket.io server unrewritten

The production edge (k8s Ingress for `outreach.su`) SHALL route `/socket.io` requests to the API service with the `/socket.io` path preserved. The Ingress-wide `rewrite-target` used to strip the `/api` prefix SHALL NOT rewrite the socket.io path to `/`. The socket.io WebSocket upgrade SHALL complete so that the browser establishes a `wss://outreach.su/socket.io/` connection without entering a reconnect loop.

#### Scenario: Browser establishes a realtime connection

- **WHEN** the admin UI loads in production and opens its socket.io client
- **THEN** the `/socket.io` handshake and WebSocket upgrade succeed against the API service
- **AND** the browser console shows no repeating `WebSocket connection to 'wss://outreach.su/socket.io/...' failed` errors

#### Scenario: REST and SPA routing are unaffected

- **WHEN** the edge routes a `/api/...` request and a `/` SPA request after the socket.io fix
- **THEN** `/api/...` is still rewritten to the API service with the `/api` prefix stripped
- **AND** `/` still serves the web SPA bundle

### Requirement: Missing static assets return 404 rather than the SPA shell

The container serving the web bundle SHALL respond to a request for a missing `/assets/*` file with HTTP `404` and SHALL NOT fall back to serving `index.html`. Application navigation paths (non-asset routes) SHALL continue to fall back to `index.html` so client-side routing works on deep links.

#### Scenario: Stale chunk request fails cleanly

- **WHEN** the browser requests a hashed asset (e.g. `/assets/ContactsPage-XXXX.js`) that no longer exists in the deployed bundle
- **THEN** the server responds `404` with no `index.html` body
- **AND** the browser does not report `Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`

#### Scenario: Deep-link navigation still resolves

- **WHEN** the browser requests an application route (e.g. `/inbox/<id>`) that is not a static file
- **THEN** the server returns `index.html` so the SPA router can resolve the route
