# apps/web - Hearth PWA

Vite + React 18 + TypeScript. Single bundle. Plain CSS, no design system.

Three routes (hash-routed, no react-router):

- `#/` (home): lists devices and rooms, allows click-to-show current state
  via `GET /v1/devices/:id/state`.
- `#/ask`: text input + send; submits to `POST /v1/interpret` and shows
  the returned `RoutingDecision` JSON.
- `#/history`: placeholder. No list-receipts endpoint exists yet; show
  a deliberate "not implemented" notice rather than fabricating data.

## Same-origin in production

The dev server proxies `/v1`, `/healthz`, `/readyz` to
`http://127.0.0.1:8787` so cookies stay on the same origin and the
browser never has to handle CORS. **This proxy is a dev-only
convenience.** Production deployments must serve the built PWA from
the same origin as the control service. The supported topologies are:

- **Caddy / nginx reverse-proxy**. Mount the built bundle at `/` and
  forward `/v1`, `/healthz`, `/readyz` to the control service. The
  PWA never speaks to the API via an absolute URL; the `HearthApi`
  client uses relative paths.
- **Co-located deployment**. If the PWA bundle is served by the same
  process as `/v1/...` (e.g. a single Fastify process), no reverse
  proxy is needed.
- **`Dockerfile` `hearth-web` service** in `docker-compose.yml` is
  illustrative only; replace with the topology that matches the
  deployment host.

The PWA does **not** bundle any production routing story; the
deployer is responsible for ensuring the API is reachable on the
same origin.

## Authentication

The PWA sends:
- `cookie: hearth_session=<session-cookie>` (parsed from the
  `Set-Cookie` header the first session-create returned).
- `x-hearth-csrf: <csrf-token>` on every state-changing request
  (`POST`, `PUT`, `PATCH`, `DELETE`).

In production (`HEARTH_REQUIRE_DEV_TOKEN` set on the control
service), the operator must mint a session via an out-of-band path
(reverse-proxy + real auth). The PWA's auto-session-create only
runs in dev mode.

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
