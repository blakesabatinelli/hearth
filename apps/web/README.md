# apps/web - Hearth PWA

Vite + React 18 + TypeScript. Single bundle. Plain CSS, no design system.

Hash-routed screens (no react-router):

- `#/` (home): overview of ready, discovered, and read-only devices.
- `#/rooms`: room and device controls with live state.
- `#/favorites`: locally saved favorite devices.
- `#/ask`: decision method, requested target, and plain-language execution
  result. Signed proposal receipts and session identifiers are not rendered.
- `#/routines`: saved routine creation and management.
- `#/attention`: devices and controls that need review.
- `#/history`: executor receipt history with per-target outcomes.
- `#/devices`: discovered device inventory and control eligibility.

## Same-origin in production

The dev server proxies `/v1`, `/healthz`, and `/readyz` to loopback control.
Production uses `server.mjs` to serve the built PWA and proxy only those API
paths to loopback control. Both preserve same-origin cookies and avoid CORS.

`server.mjs` provides the production same-origin gateway. It serves the
built PWA, proxies only `/v1/*`, `/healthz`, and `/readyz` to the loopback
control API, and binds to loopback by default. It rejects non-loopback
control URLs and web bind addresses. To run it after `pnpm build`:

```bash
pnpm --filter @hearth/web start:prod
```

For Tailscale Serve, set `HEARTH_TAILSCALE_ALLOWED_USERS` to the exact
Tailscale login identities allowed to use Hearth, then serve the loopback web
port. Remote requests without an allowed `Tailscale-User-Login` header are
rejected. Tailscale Serve strips caller-supplied identity headers before it
forwards the authenticated identity. Keep the control API on loopback and do
not enable Funnel.

## Authentication

The PWA sends:
- `cookie: hearth_session=<session-cookie>` (parsed from the
  `Set-Cookie` header the first session-create returned).
- `x-hearth-csrf: <csrf-token>` on every state-changing request
  (`POST`, `PUT`, `PATCH`, `DELETE`).

The local session flow grants the configured admin role only when
`HEARTH_ALLOW_DEV_ADMIN=1` is explicitly set on the loopback control service.
Before enabling remote access, restrict the production web gateway to the
approved Tailscale login identities and review the tailnet's access policy.
The API remains unavailable over the host's Tailscale interface directly.

## Build

```bash
pnpm --filter @hearth/web build    # output: apps/web/dist/
pnpm --filter @hearth/web dev      # vite dev server: http://localhost:5173
pnpm --filter @hearth/web preview  # serve the built bundle: http://localhost:5173
```

## Tests

Tests use vitest + happy-dom. `tests/setup.ts` configures globals;
individual test files use `vi.mocked(globalThis.fetch)` to stub the
HTTP boundary; no real backend is required.

```bash
pnpm --filter @hearth/web test
```
