# Hearth v3.0

Hearth v3.0 is a structurally-complete, fixture-mode-validated control
harness for household device automation. It is ready for deployment-machine
validation against real OpenClaw, Bonsai, GLiNER2, and Home Assistant.

## Highlights

- **Five TypeScript library packages** with 109 fixture-mode tests:
  `@hearth/contracts`, `@hearth/registry`, `@hearth/ha-adapter`,
  `@hearth/executor`, `@hearth/interpreter`, plus
  `@hearth/extractor` (HTTP client + mock for the GLiNER2 sidecar).
- **One durable schedules package**: `@hearth/scheduler` with cron,
  holds, persistence, and recovery.
- **A Fastify HTTP control service** (`apps/control`) with sessions,
  CSRF, idempotency, server-derived contracts, error mapping, evidence,
  and a `doctor` subcommand.
- **A PWA** (`apps/web`, Vite + React 18, hash-routed).
- **Multi-stage Dockerfile** + `docker-compose.yml` + `install.sh` +
  `doctor.sh` + `rollback.sh`.
- **Model locks** for Bonsai and GLiNER2 with `verify-*.mjs` guards.

## Test totals

```
183 tests across 9 projects:
  packages/contracts:           7
  packages/registry:           12
  packages/ha-adapter:         15
  packages/executor:           31
  packages/interpreter:        44
  packages/extractor:           8
  packages/scheduler:          14
  apps/control:                29
  apps/web:                    23
```

All projects typecheck clean (tsc 5.6.3). The portable verifier, the
Bonsai lock verifier, the GLiNER2 lock verifier, and gitleaks all
report OK.

## What's new vs v2.x

- **Mandatory GLiNER2 extraction** is now part of the interpretation
  pipeline (ADR-2026-09-24-gliner2-required).
- **First-class `DispatchAck.no-op`** so the executor can report
  already-satisfied state honestly.
- **OpenClaw is consumed via its supported external Gateway API**
  (per https://docs.openclaw.ai/gateway/external-apps). Pin:
  OpenClaw `v2026.9.6`, commit `ce5bbdc244ee937246cc1700d1b224d020c3b599`.
- **GLiNER2 is consumed via `apps/extract/` (FastAPI Python sidecar)**.
  Pin: GLiNER2 `v2.0.0`, commit `3c913c7369301133d3b7699252074c4303ada50e`,
  checkpoint `fastino/gliner2.5-base-v1`.
- **No cloud-model fallback** is present. Bonsai is local-only.
- **No external action without approval.** Money, software updates,
  new outbound contacts - all gated behind `ForbiddenFieldError` or
  explicit operator consent.
- **No secrets, no credentials, no RFC1918 addresses** in the
  repository. Loopback examples (`127.0.0.1`) are allowed.
- **Em dashes are forbidden** in source, scripts, and docs. The
  portability verifier rejects them.

## What's NOT validated in this release

The harness is structurally complete. The following real-world
resources live on the deployment machine and were NOT exercised here:

- Live Home Assistant instance + token.
- Real HA device discovery, entity-id resolution, real device states.
- OpenClaw Gateway + OAuth flow (per their external-app docs).
- Bonsai 27B inference with the actual GGUF weights.
- GLiNER2 inference with the actual `fastino/gliner2.5-base-v1` checkpoint.
- A labeled evaluation corpus for ambiguity-pruning quality scores.
- A household device allowlist populated from the real HA instance.

Run `DEPLOYMENT.md` end to end on the deployment host, then proceed
to Stage 8 in `HEARTH_HERMES_DEVELOPMENT_PLAN.md` (the labeled
evaluation / observed-behavior validation) before declaring v3.0
production-ready.

## Upgrade

```bash
git fetch origin --tags
git checkout v3.0
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './apps/*' build
docker compose --profile with-extract up -d
docker compose exec hearth-control node apps/control/dist/src/main.js doctor
```

If you were running an earlier Hearth container, `./scripts/rollback.sh`
restores the previous image.
