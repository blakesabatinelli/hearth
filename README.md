# Hearth

An installable home management system. PWA front end + independent TypeScript control service + pinned OpenClaw conversational runtime + local Bonsai 27B language model.

**Status:** Stage 0 (Repository and compatibility spike). No release yet. See `STATE.md`.

**Plan:** `HEARTH_HERMES_DEVELOPMENT_PLAN.md` v3.0.

**How to work this repo:** read `AGENTS.md` first.

## Architecture

```
Hearth PWA  ->  hearth-control (API + executor + scheduler)
                       |
                       v
              deterministic parser + resolver
                       |
                       v
              OpenClaw Gateway (separate process)
                       |
                       v
              Bonsai 27B (separate process)
                       |
                       v
              Home Assistant + adapters (HA, Hue, SmartThings, Alexa)
```

Direct controls, saved routines, and recovery all work with OpenClaw and Bonsai stopped. OpenClaw is used only for interpretation. Bonsai is used only for interpretation. See `docs/architecture.md`.

## Workspace

```
apps/control/       hearth-control service
apps/web/           PWA
packages/contracts/ shared types (contract, receipt, intent proposal)
packages/registry/  canonical device identity + overlay
packages/interpreter/ grammar-first parser + Bonsai fallback resolver
packages/executor/  executor + per-target evidence + receipts
packages/routines/  durable scheduler
packages/ha-adapter/  fake-HA default, real HA by config
packages/discovery/   LAN + hub + account importers + coverage report
packages/openclaw-adapter/ restricted adapter into pinned OpenClaw
packages/cli/         install / configure / doctor / backup / upgrade / rollback / uninstall
```

## Layout conventions

- Each package owns its own `package.json`, `tsconfig.json` (extending `tsconfig.base.json`), `src/`, optional `tests/`.
- One package, one purpose. No cross-cutting utility packages at Stage 0.
- Tests live under `tests/{unit,integration,e2e,failure}` (workspace-wide) or inside each package's `tests/` (unit).

## Bonsai model lock

`models/bonsai.lock.json` pins the model profile. Real weights are deferred per Decision 1 (2026-09-24); the `mock-bonsai` adapter stands in until Blake provides a serving-runtable Bonsai.

## Forbidden

- No em dashes anywhere in committed files (use regular `-`).
- No home-directory paths in tracked files. Reference `~/` or `<home>/` if you must; never commit a real machine-specific path.
- No re-pairing of household devices.
- No Qwen, no cloud fallback. Bonsai only.