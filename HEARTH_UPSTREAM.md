# Hearth -  OpenClaw upstream pinning

> Plan §5: "Record the exact release and source commit. Do not assume an upstream cron database, plugin directory layout, or deterministic cron callback exists until inspecting that version."

## Status

Pinned. Inspected via shallow clone of `https://github.com/openclaw/openclaw` on 2026-09-24.

## Pin

- Upstream: **https://github.com/openclaw/openclaw**
- LICENSE: **MIT** (Copyright (c) 2026 OpenClaw Foundation)
- Current HEAD commit: **79241f0a62d297a514622fe5ee98404acdf8e608** (2026-09-23 23:58:50 -0700) -  `test(plugins): pin capability provider acquisition custody (#157090)`
- Latest tagged release: **v2026.9.6** (commit `ce5bbdc244ee937246cc1700d1b224d020c3b599`) -  this is the host/plugin API version to test against
- Stable external-app docs cite: **2026.8.1** packages (`@openclaw/gateway-client`)
- Plugin SDK compatibility tag: **pluginApi >= 2026.9.6**
- Package version (per upstream `package.json` at HEAD): **2026.9.6**

## Integration shape (re-read from upstream docs)

Two distinct integration paths exist; Hearth uses the external-app one:

1. **External app** (our path). Plan §5 + §6 cite this. Hearth runs as a standalone process and speaks to OpenClaw's Gateway via WebSocket + RPC. This is the **stable, supported, npm-packaged** surface per `docs/gateway/external-apps.md`.
2. **In-process plugin** (NOT our path). OpenClaw extensions (172 of them in this repo) live inside the OpenClaw runtime and use `@openclaw/plugin-sdk` subpaths. Plan §5 specifically warns "Do not invent upstream package locations and reorganize OpenClaw around them."

**Decision rationale** (also in DECISIONS.md Decision 4): the plan's "Use supported Gateway/plugin interfaces when available" instruction maps cleanly to the **external-app** integration. Hearth cannot be a sibling workspace package that pulls 49k files of OpenClaw source -  that is the visibility/maintenance path the plan §5 #3 warned against. A standalone repo that depends on OpenClaw's Gateway protocol over WebSocket (with `openclaw` npm client or a minimal hand-written client) is the supported route.

## Inspection notes (from shallow clone, 2026-09-24)

- **Repo size at HEAD**: 49,252 files, 5,592 dirs. Includes `apps/{android,ios,linux,macos,macos-mlx-tts,mobile,shared,swabble}`, 23 `packages/`, 172 `extensions/`, 649 `scripts/`, 16 `docs/`, ~128 `src/` modules.
- **Top-level of interest to Hearth:**
 - `packages/plugin-sdk/` -  the in-process plugin SDK (Hearth will *not* use this; documented for completeness).
 - `packages/plugin-package-contract/` -  package manifest contract for in-process plugins (not our path).
 - `packages/gateway-client/` and `packages/gateway-protocol/` -  WebSocket client + protocol types. **This is our dependency.**
 - `examples/ai-chat/` -  example external-app integration.
 - `docs/gateway/external-apps.md` -  primary integration doc.
 - `docs/gateway/clients.md` -  Gateway client install guide (cited from external-apps.md).
- **License**: MIT, preserves in `THIRD_PARTY_NOTICES.md` once Hearth ships any binary that links OpenClaw code. As a thin WebSocket client over a third-party process, Hearth currently links *zero* OpenClaw source; this changes only if we vendor a client.
- **Cron / scheduling**: OpenClaw has its own scheduler (`docs/automation/cron-jobs.md`). Hearth explicitly does **not** rely on it -  `hearth-control` owns scheduling per plan §9. We document this here so future agents don't try to consolidate.

## Strategy

- **Hearth's `hearth-openclaw` service** is an OpenClaw Gateway *client*. It runs as a separate process from `hearth-control`. It exposes one bounded RPC pattern: `agent` runs with a `hearth.propose_intent` tool registered.
- **No OpenClaw source vendored.** We depend on `@openclaw/gateway-client` (or compatible) from npm at install time, OR hand-write a minimal WebSocket client against `docs/gateway/protocol.md` (cheaper, no pinned dependency churn).
- **Stage 0 gate**: prove a request round trip through a live OpenClaw Gateway (or a stubbed one with the same protocol shape, marked honestly) returning a schema-checked intent proposal. Bonsai runtime can be mocked via `mock-bonsai`. Gate is honest about partial real-model round-trip.

## Patches

- None at Stage 0. If a future blocker requires a patch, record it in `patches/CORE_PATCHES.md` with original SHA, patch, reason, test, removal condition.