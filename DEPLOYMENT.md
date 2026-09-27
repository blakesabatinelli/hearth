# Deployment

This file documents a local Docker Compose development stack. It is not the
production remote-access setup for the active household host. For the live
Apple Silicon setup, follow `docs/macos-host-setup.md` and the iPad/Tailscale
plan in `docs/plan-ipad-full-activation.md`.

The Compose profile defaults to fixture mode. Its PWA is a development server
with an internal API proxy, and both published ports are bound to host
loopback. Do not expose the Compose ports to a LAN or use the Compose PWA as a
Tailscale Serve target. Production remote access must use the same-origin
gateway in `apps/web/server.mjs`, bound to host loopback and restricted to an
allowlisted Tailscale identity.

## Required machine resources

| Component        | Min                                       | Where it lives                                                                                                            |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Control API      | Node.js 22, 512 MB RAM, 1 vCPU            | `apps/control/dist/src/main.js`                                                                                           |
| PWA              | Static; 50 MB disk                        | `apps/web/dist/` served by `serve`                                                                                        |
| Extract sidecar  | Python 3.11 + `gliner2>=2.0.0,<3.0.0`     | `apps/extract/.venv/bin/uvicorn hearth_extract:app --port 8765`                                                           |
| Bonsai (optional)| GGUF weights; depends on model size       | `models/bonsai/` (NOT shipped with Hearth - download via `hfetch` or your distribution's release page)                     |
| Home Assistant   | URL + long-lived token                    | environment variables `HEARTH_HA_URL` + `HEARTH_HA_TOKEN` (read at startup only - never logged)                           |
| OpenClaw Gateway | External Gateway (per OpenClaw docs)      | `HEARTH_OPENCLAW_GATEWAY_URL` (and OAuth credentials handled by the OpenClaw client used in Hearth's external-app adapter) |

## Required environment variables

```bash
# Required.
HEARTH_SESSION_SECRET=...          # openssl rand -hex 32

# Recommended.
HEARTH_SQLITE_PATH=/var/lib/hearth/hearth.sqlite
HEARTH_EXTRACT_URL=http://127.0.0.1:8765
HEARTH_HA_URL=http://homeassistant.local:8123
HEARTH_HA_TOKEN=...                # long-lived access token
HEARTH_OPENCLAW_GATEWAY_URL=http://127.0.0.1:7777

# Optional.
HEARTH_PORT=8787
HEARTH_HOST=0.0.0.0
HEARTH_LOG_LEVEL=info              # debug | info | warn | error
HEARTH_BONSAI_MODEL_PATH=/var/lib/hearth/bonsai-q8.gguf
HEARTH_GLINER2_MODEL_ID=fastino/gliner2.5-base-v1   # pinned in models/gliner2.lock.json
```

## Install

```bash
# As root, on a fresh Debian 12 box:
curl -fsSL https://raw.githubusercontent.com/<owner>/hearth/main/scripts/install.sh | bash
```

The installer will:
1. Install Node 22 + Python 3.11 + pnpm + build deps.
2. Clone Hearth into `/opt/hearth`.
3. Run `pnpm install` + `pnpm -r build` + `pnpm -r test`.
4. Print the next-step instructions.

## Run with docker compose

```bash
cd /opt/hearth
docker compose --profile with-extract up -d
```

Services:
- `hearth-control`: fixture API on host loopback `127.0.0.1:8787`.
- `hearth-web`: development PWA with proxy to the internal control service,
  published on host loopback `127.0.0.1:5173`.
- `hearth-extract`: GLiNER2 sidecar on `:8765` (only with `--profile with-extract`).

## Verify

```bash
# From the host:
./scripts/doctor.sh
# or inside the container:
docker compose exec hearth-control node apps/control/dist/src/main.js doctor
```

The doctor checks: node version, SQLite path, session-secret strength,
GLiNER2 sidecar reachability, and the presence of the model lock files.

## Roll back

```bash
./scripts/rollback.sh    # rolls the running stack to hearth:previous
```

Requires that `docker compose` has previously taken a `hearth:previous`
tag (the default `docker compose up -d` does not, by design - use
`./scripts/upgrade.sh` which takes care of it explicitly).

## Current household host status

The active Apple Silicon host has live Home Assistant, OpenClaw, Bonsai,
GLiNER2, control, and PWA services. The controller discovers 56 HA records;
only two physically verified lamp entities are enabled for actuation. Stage 1
fixture checks and the Stage 3 frozen synthetic corpus pass. See `STATE.md` for
current evidence and `docs/gates.md` for gate definitions.

Household expansion still requires physical device identity, route, load, and
feedback review. Tailscale is not installed on the host because its installer
needs local administrator authorization and VPN configuration approval. Do
not interpret the fixture Compose profile as live-device or remote-access
validation.
