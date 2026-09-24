# Hearth

An installable home management system. PWA front end + independent TypeScript control service + pinned OpenClaw conversational runtime + local Bonsai 27B language model.

**Status:** Stage 0 (Repository and compatibility spike). No release yet. See `STATE.md`.

**Plan:** `HEARTH_HERMES_DEVELOPMENT_PLAN.md` v3.0.

**How to work this repo:** read `AGENTS.md` first.

## Install and run on macOS

The complete Apple Silicon host setup is in [`docs/macos-host-setup.md`](docs/macos-host-setup.md). It gives command-by-command instructions to:

- Clone the public `main` branch.
- Install, build, test, and start the current Hearth source.
- Download and serve the pinned Bonsai 27B GGUF.
- Install and configure the pinned OpenClaw runtime.
- Install and run the GLiNER2 sidecar.
- Install or connect Home Assistant without re-pairing existing devices.
- Verify each process and identify the integration work that remains before live actuation.

Start with:

```bash
mkdir -p "$HOME/src"
cd "$HOME/src"
git clone --branch main --single-branch https://github.com/<owner>/hearth.git
cd hearth
sed -n '1,240p' docs/macos-host-setup.md
```

This repository is still at Stage 0. The checked-in application runs in fixture mode, and the setup guide does not claim that the current revision provides a complete live-device integration.

## Architecture

```
Hearth PWA  ->  hearth-control (API + executor + scheduler)
                       |
                       v
              grammar parser + resolver  (deterministic, in hearth-control)
                       |
                       |  if grammar incomplete:
                       v
              hearth-extract (GLiNER2 Python sidecar, separate process)
                       |
                       |  if extraction incomplete AND context-dependent:
                       v
              hearth-openclaw (separate process) -> hearth-bonsai (separate process)
                       |
                       v
              Home Assistant + adapters (HA, Hue, SmartThings, Alexa)
```

Direct controls, saved routines, and recovery all work with OpenClaw, GLiNER2, and Bonsai stopped. The grammar parser alone handles unambiguous commands. OpenClaw/Bonsai/GLiNER2 are used only for interpretation. See `docs/architecture.md` (Stage 6) and `docs/decisions/ADR-2026-09-24-gliner2-required.md`.

## Workspace

```
apps/control/       hearth-control service (TypeScript)
apps/extract/       hearth-extract Python sidecar (GLiNER2 runtime)
apps/web/           PWA
packages/contracts/ shared types (contract, receipt, intent proposal, extraction)
packages/registry/  canonical device identity + overlay
packages/interpreter/ grammar-first parser + GLiNER2/Bonsai fallback resolver
packages/executor/  executor + per-target evidence + receipts
packages/routines/  durable scheduler
packages/ha-adapter/  fake-HA default, real HA by config
packages/discovery/   LAN + hub + account importers + coverage report
packages/openclaw-adapter/ restricted adapter into pinned OpenClaw
packages/extractor/   TypeScript-side adapter for the hearth-extract sidecar
packages/cli/         install / configure / doctor / backup / upgrade / rollback / uninstall
```

## Layout conventions

- Each package owns its own `package.json`, `tsconfig.json` (extending `tsconfig.base.json`), `src/`, optional `tests/`.
- One package, one purpose. No cross-cutting utility packages at Stage 0.
- Tests live under `tests/{unit,integration,e2e,failure}` (workspace-wide) or inside each package's `tests/` (unit).

## Bonsai + GLiNER2 model locks

`models/bonsai.lock.json` pins the Bonsai 27B reasoning model. Real weights are deferred to the deployment machine; the `mock-bonsai` adapter stands in until they are available.

`models/gliner2.lock.json` pins the GLiNER2 extractor (v2.0.0, Apache-2.0). GLiNER2 is the first model used for natural-language requests (ADR-2026-09-24-gliner2-required). It runs in a separate `hearth-extract` Python sidecar; hearth-control calls over a local socket.

## Forbidden

- No em dashes anywhere in committed files (use regular `-`).
- No home-directory paths in tracked files. Reference `~/` or `<home>/` if you must; never commit a real machine-specific path.
- No re-pairing of household devices.
- No Qwen, no cloud fallback. Bonsai only.
