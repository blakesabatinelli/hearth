# macOS host setup

This runbook targets an Apple Silicon Mac and the Hearth source tree. It installs and starts:

- Bonsai 27B 1-bit through `llama-server` with Metal acceleration.
- OpenClaw 2026.9.6 configured to use that local Bonsai server.
- The Hearth GLiNER2 sidecar with the pinned GLiNER2 2.0.0 package.
- Home Assistant OS in a local virtual machine, or an existing Home Assistant instance.
- The current Hearth control API and PWA in live Home Assistant mode.

## Current setup status

Updated 2026-09-27. Hearth, OpenClaw, Bonsai, GLiNER2, and Home Assistant run
locally. Four Hearth user LaunchAgents now manage Bonsai, GLiNER2, control, and
the production PWA. The current Home Assistant instance exposes 56 discovered
records; only two previously verified bedroom lamps are enabled for live
actuation. The Hue room group stays excluded.

## 1. Download the Hearth source code

Open Terminal. Confirm that this is an Apple Silicon Mac:

```bash
uname -m
sw_vers
```

Expected architecture:

```text
arm64
```

Install Apple's command-line developer tools if they are not already installed:

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install
```

If macOS opens an installer window, finish that installation before continuing.

Clone the public `main` branch into a predictable location:

```bash
mkdir -p "$HOME/src"
cd "$HOME/src"
git clone --branch main --single-branch https://github.com/<owner>/hearth.git
cd "$HOME/src/hearth"
export HEARTH_REPO="$PWD"
```

Verify that the checkout came from the intended repository and branch:

```bash
git remote get-url origin
git branch --show-current
git status --short
git rev-parse HEAD
```

Required results:

```text
https://github.com/<owner>/hearth.git
main
```

`git status --short` should print nothing in a fresh clone. Record the commit printed by `git rev-parse HEAD`; it identifies the exact source revision being installed.

If the repository is already cloned, do not clone it again. Use the existing checkout, inspect `git status --short`, and do not discard local changes. To update a clean checkout to the current public `main` branch, run:

```bash
cd "$HOME/src/hearth"
git fetch origin
git switch main
git pull --ff-only origin main
export HEARTH_REPO="$PWD"
```

Read the repository working rules and current status before continuing:

```bash
sed -n '1,240p' AGENTS.md
sed -n '1,240p' STATE.md
```

## 2. Create installation-local directories

These variables are referenced throughout this guide. Either run them
in every shell before continuing, or persist them in `~/.zshenv` so they
load on every new shell.

```bash
export HEARTH_RUNTIME_ROOT="$HOME/Library/Application Support/Hearth"
export HEARTH_MODEL_DIR="$HEARTH_RUNTIME_ROOT/models/bonsai"
export HEARTH_DATA_DIR="$HEARTH_RUNTIME_ROOT/data"
export HEARTH_LOG_DIR="$HEARTH_RUNTIME_ROOT/logs"
export HEARTH_SECRET_DIR="$HEARTH_RUNTIME_ROOT/secrets"

# Optional but recommended: re-export on every new shell.
# Add the four HEARTH_*_DIR lines above to ~/.zshenv if you want them
# to persist across shells.

mkdir -p "$HEARTH_MODEL_DIR" "$HEARTH_DATA_DIR" "$HEARTH_LOG_DIR" "$HEARTH_SECRET_DIR"
chmod 700 "$HEARTH_RUNTIME_ROOT" "$HEARTH_SECRET_DIR"

# Verify the variable expanded to a real path. If this prints '/...'
# instead of '$HOME/Library/.../secrets', the variable was not set
# in this shell; re-export from section 2 or source ~/.zshenv.
: "${HEARTH_SECRET_DIR:?HEARTH_SECRET_DIR is not set - re-run section 2 in this shell}"
echo "HEARTH_SECRET_DIR=$HEARTH_SECRET_DIR"
```

Keep weights, databases, logs, and secrets outside the Git repository.

## 3. Install host prerequisites

If Homebrew is not already installed, install it from the official installer:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Load Homebrew in the current Terminal:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

```bash
brew update
brew install node@24 uv python@3.11 llama.cpp jq curl
```

Put the supported Node runtime first for this Terminal session:

```bash
export PATH="$(brew --prefix node@24)/bin:$PATH"
hash -r
node --version
npm --version
uv --version
python3.11 --version
llama-server --version
```

Required results:

- Node is 24.16 or newer.
- Python is 3.11.
- `llama-server` starts and reports a build version.

## 4. Build and test Hearth

```bash
cd "$HEARTH_REPO"
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm verify:lock
pnpm verify:portability
```

Stop if any command fails.

## 5. Download and verify Bonsai 27B 1-bit

Download the exact GGUF artifact selected by the Hearth plan:

```bash
uvx --from huggingface_hub hf download \
  prism-ml/Bonsai-27B-gguf \
  Bonsai-27B-Q1_0.gguf \
  --revision f10afb355f104535e3e3e98cf7ab7795c72bd292 \
  --local-dir "$HEARTH_MODEL_DIR"
```

Verify the downloaded artifact:

```bash
cd "$HEARTH_MODEL_DIR"
printf '%s  %s\n' \
  '17ef842e47450caeb8eaa3ebfbbab5d2f2278b62b79be107985fb69a2f819aa0' \
  'Bonsai-27B-Q1_0.gguf' | shasum -a 256 -c -
```

Expected output:

```text
Bonsai-27B-Q1_0.gguf: OK
```

Do not download the F16 file. It is about 54 GB and is not the selected Hearth profile. Do not download the vision projector, Open WebUI, code interpreter, or speculative drafter for the initial text-only profile.

## 6. Start Bonsai

Open a second Terminal window and run:

```bash
export HEARTH_RUNTIME_ROOT="$HOME/Library/Application Support/Hearth"
export HEARTH_MODEL_DIR="$HEARTH_RUNTIME_ROOT/models/bonsai"

llama-server \
  --model "$HEARTH_MODEL_DIR/Bonsai-27B-Q1_0.gguf" \
  --alias bonsai-27b-q1 \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 16384 \
  --n-gpu-layers 99 \
  --parallel 1 \
  --reasoning-budget 256
```

Leave that Terminal window open.

In the first Terminal window, verify the server:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/v1/models | jq .
```

Run one bounded completion:

```bash
curl -fsS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bonsai-27b-q1",
    "messages": [
      {
        "role": "system",
        "content": "Return JSON only. Never invent device identifiers, user identity, roles, permissions, or execution policy."
      },
      {
        "role": "user",
        "content": "Interpret: turn off the kitchen lights except the island."
      }
    ],
    "temperature": 0.7,
    "top_p": 0.95,
    "max_tokens": 512,
    "thinking_budget_tokens": 256,
    "response_format": {
      "type": "json_object"
    }
  }' | jq .
```

This proves that the model server responds. It does not prove Hearth's intent schema or safety gates.

## 7. Install and configure OpenClaw

Install the exact version pinned by Hearth:

```bash
export PATH="$(brew --prefix node@24)/bin:$PATH"
npm install -g openclaw@2026.9.6 --allow-scripts=openclaw
openclaw --version
```

Expected version:

```text
OpenClaw 2026.9.6
```

Create a Gateway token without printing it. If `$HEARTH_SECRET_DIR`
is unset, the redirect would target `/openclaw-gateway-token` on the
read-only system root, so guard explicitly:

```bash
umask 077
: "${HEARTH_SECRET_DIR:?must be set - re-run section 2 in this shell}"
openssl rand -hex 32 > "$HEARTH_SECRET_DIR/openclaw-gateway-token"
chmod 600 "$HEARTH_SECRET_DIR/openclaw-gateway-token"
export OPENCLAW_GATEWAY_TOKEN="$(< "$HEARTH_SECRET_DIR/openclaw-gateway-token")"
echo "Wrote gateway token to $HEARTH_SECRET_DIR/openclaw-gateway-token (umask 077, 600)"
```

The OpenClaw LaunchAgent resolves this token reference from the macOS
user launchd environment. Set it there before installing or starting the
service. Repeat this command after logging out or restarting the Mac.

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "$(< "$HEARTH_SECRET_DIR/openclaw-gateway-token")"
```

Configure OpenClaw to use the already-running Bonsai server:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice custom-api-key \
  --custom-provider-id bonsai-local \
  --custom-base-url http://127.0.0.1:8080/v1 \
  --custom-model-id bonsai-27b-q1 \
  --custom-text-input \
  --gateway-bind loopback \
  --gateway-port 18789 \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --secret-input-mode ref \
  --workspace "$HEARTH_RUNTIME_ROOT/openclaw-workspace" \
  --install-daemon \
  --skip-channels \
  --skip-search \
  --skip-skills \
  --skip-ui
```

OpenClaw 2026.9.6 does not accept `llama-cpp-existing-server` as an
`--auth-choice`; the custom OpenAI-compatible provider options above
configure the local llama-server endpoint. Restrict the agent tools and
match OpenClaw's model context to the server:

```bash
openclaw config set tools.profile minimal
openclaw config set models.providers.bonsai-local.models.0.contextWindow 16384 --strict-json
openclaw config set models.providers.bonsai-local.models.0.maxTokens 512 --strict-json
```

Verify OpenClaw:

```bash
openclaw config validate
openclaw models list
openclaw gateway status
openclaw health
```

Run one local model turn:

```bash
openclaw agent \
  --agent main \
  --thinking off \
  --timeout 240 \
  --message 'Reply with exactly: BONSAI_OK'
```

If Gateway installation did not start the service, run:

```bash
openclaw gateway start
openclaw gateway status
```

OpenClaw must remain loopback-only. Do not add channels, browser tools, shell tools, general HTTP tools, or home-control credentials to this Hearth-specific runtime.

## 8. Install GLiNER2

Return to the Hearth repository:

```bash
cd "$HEARTH_REPO"
```

Create the Python 3.11 environment:

```bash
uv venv --python "$(brew --prefix python@3.11)/bin/python3.11" apps/extract/.venv
```

Install the pinned inference package and sidecar dependencies:

```bash
uv pip install \
  --python apps/extract/.venv/bin/python \
  'gliner2[local]==2.0.0' \
  'fastapi>=0.115,<1' \
  'uvicorn[standard]>=0.32,<1' \
  'pydantic>=2.9,<3'

uv pip install \
  --python apps/extract/.venv/bin/python \
  --no-deps \
  -e apps/extract
```

Verify the package version and download the checkpoint with a real load:

```bash
apps/extract/.venv/bin/python -c '
from importlib.metadata import version
from gliner2 import AutoExtractor
assert version("gliner2") == "2.0.0", version("gliner2")
AutoExtractor.from_pretrained("fastino/gliner2.5-base-v1")
print("GLINER2_MODEL_OK")
'
```

The first load downloads the checkpoint from Hugging Face. Stop if the final line is not `GLINER2_MODEL_OK`.

## 9. Start GLiNER2

Open another Terminal window and run:

```bash
export HEARTH_REPO="$HOME/src/hearth"
cd "$HEARTH_REPO"
export HEARTH_GLINER2_CHECKPOINT=fastino/gliner2.5-base-v1
export HEARTH_EXTRACT_HOST=127.0.0.1
export HEARTH_EXTRACT_PORT=8770
apps/extract/.venv/bin/hearth-extract
```

Leave that Terminal window open.

Verify health from the first Terminal:

```bash
curl -fsS http://127.0.0.1:8770/health | jq .
```

Required result:

```json
{
  "ready": true,
  "checkpoint_id": "fastino/gliner2.5-base-v1",
  "latency_ms_p50": null,
  "degraded_reason": null
}
```

Exercise the actual sidecar endpoint:

```bash
curl -fsS http://127.0.0.1:8770/extract \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "mac-smoke-1",
    "utterance": "turn off the kitchen lights",
    "schema": {
      "schema_version": "0.0.1",
      "entity_types": ["device_target", "room"],
      "classification_labels": ["on", "off"],
      "relations": [],
      "known_aliases": []
    }
  }' | jq .
```

Do not treat `/health` alone as proof. The `/extract` request must return HTTP 200 and a body containing the same `request_id` and `original_utterance`. If it returns HTTP 500, the sidecar's GLiNER2 2.0.0 API call needs to be corrected before Hearth can use it.

## 9a. Fine-tune GLiNER2 locally

Hearth's pilot trainer uses LoRA and keeps household names and example
utterances under the local Application Support directory. It does not upload
training data. Set the room and exact approved device names from Home Assistant:

```bash
export HEARTH_RUNTIME_ROOT="$HOME/Library/Application Support/Hearth"
export HEARTH_GLINER2_DATA="$HEARTH_RUNTIME_ROOT/models/gliner2/pilot-data"
export HEARTH_PILOT_ROOM='room name from Home Assistant'
export HEARTH_PILOT_DEVICE_ONE='first approved light name'
export HEARTH_PILOT_DEVICE_TWO='second approved light name'

apps/extract/.venv/bin/python scripts/generate-gliner2-pilot-data.py \
  --room "$HEARTH_PILOT_ROOM" \
  --device "$HEARTH_PILOT_DEVICE_ONE" \
  --device "$HEARTH_PILOT_DEVICE_TWO" \
  --output-dir "$HEARTH_GLINER2_DATA"

export HEARTH_GLINER2_MODEL_OUT="$HEARTH_RUNTIME_ROOT/models/gliner2/hearth-pilot"
TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=4 \
  apps/extract/.venv/bin/python scripts/train-gliner2-local.py \
  --base-model fastino/gliner2.5-base-v1 \
  --train-jsonl "$HEARTH_GLINER2_DATA/train.jsonl" \
  --eval-jsonl "$HEARTH_GLINER2_DATA/eval.jsonl" \
  --output-dir "$HEARTH_GLINER2_MODEL_OUT"

apps/extract/.venv/bin/python scripts/evaluate-gliner2-pilot.py \
  --checkpoint "$HEARTH_GLINER2_MODEL_OUT/merged" \
  --eval-jsonl "$HEARTH_GLINER2_DATA/eval.jsonl" \
  --report "$HEARTH_GLINER2_MODEL_OUT/pilot-evaluation.json"
```

The trainer needs a cached pinned base checkpoint and merges the learned
adapter into `merged/` for direct sidecar loading. Treat the small pilot score
as a local diagnostic. The separate frozen Stage 3 suite is in
`eval/commands/stage3-corpus.jsonl`; see `docs/gates.md` for passing report
commands and current results.

## 10. Install Home Assistant OS

If the household already has Home Assistant, do not create a second instance and do not re-pair any Hue or SmartThings devices. Skip to section 11 (token creation) and use the existing URL.

For a new local installation on Apple Silicon, two routes are supported:

### 10a. Recommended: Home Assistant Container via Docker

This is the lightest path on macOS. No virtual machine, no extra kernel modules, no re-pairing of devices. Home Assistant runs as a Docker container on `127.0.0.1:8123` and Hearth reaches it over loopback.

```bash
brew install --cask docker
open -a Docker
sleep 30
```

> If this is a fresh Docker install, the first launch shows the Docker
> Subscription Service Agreement. Accept it (or the daemon never
> starts). The whale icon in the menu bar stops animating when the
> engine is ready.

```bash
docker run -d --name homeassistant --restart=unless-stopped -p 8123:8123 -v ~/ha-config:/config -e TZ=America/Chicago homeassistant/home-assistant:stable

# Apple Silicon Docker Desktop runs containers in a Linux VM under
# the hood; --network=host does not behave like a real Linux host,
# so we publish the port explicitly with -p 8123:8123 instead.
```

```bash
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8123 2>/dev/null; then
    echo "Home Assistant reachable after ${i}*5s"
    break
  fi
  sleep 5
done
```

Open the onboarding UI:

```bash
open http://127.0.0.1:8123
```

Complete onboarding in the browser. Add the existing Hue and SmartThings integrations through Home Assistant. **Do not reset bridges, remove existing accounts, or re-pair devices.**

The control service connects to this HA instance via:

```bash
export HEARTH_HA_URL="http://127.0.0.1:8123"
```

When you want to stop the HA container:

```bash
docker stop homeassistant
```

When you want to remove it (the config persists under `~/ha-config/`):

```bash
docker rm homeassistant
```

### 10b. Optional: Home Assistant OS in a VirtualBox VM

Only use this path if you specifically need HA OS (for example, to run add-ons that require the supervisor). It is heavier than the Docker path and not required for Hearth.

Install VirtualBox:

```bash
brew install --cask virtualbox
open -a VirtualBox
```

In a browser, open the official installation page:

```bash
open https://www.home-assistant.io/installation/macos
```

Then complete these UI steps exactly:

1. Download the Apple Silicon VDI linked from the official page.
2. Extract the download if it is compressed.
3. In VirtualBox, select `New`.
4. Name the VM `Home Assistant`.
5. Leave ISO Image blank.
6. Select Linux, Oracle Linux, and ARM 64-bit.
7. Allocate at least 2048 MB RAM and 2 CPUs. On a 16 GB Mac, start with 2048 MB because Bonsai also needs unified memory.
8. Enable EFI.
9. Finish creating the VM.
10. Open the VM settings and select Storage.
11. Remove the empty placeholder disk.
12. Add the downloaded Home Assistant VDI to the VirtioSCSI controller.
13. Open Network settings.
14. Select Bridged Adapter and choose the Mac's active Ethernet or Wi-Fi interface.
15. Start the VM.

Wait for Home Assistant OS to complete first boot, then open:

```bash
open http://homeassistant.local:8123
```

If that hostname does not resolve, use the IP address displayed by the VM:

```bash
open http://<home-assistant-ip>:8123
```

The control service connects to this HA instance via:

```bash
export HEARTH_HA_URL="http://homeassistant.local:8123"
# (or the IP from the VM console if mDNS does not work)
```

Complete Home Assistant onboarding in the browser. Add the existing Hue and SmartThings integrations through Home Assistant. **Do not reset bridges, remove existing accounts, or re-pair devices.**

To shut the HA VM down cleanly:

```bash
# From the HA UI: Settings -> System -> Power Button -> Shut down.
# Or from the VM console in VirtualBox: Machine -> ACPI Shutdown.
# Do not force-stop during database writes.
```

## 11. Create and verify a Home Assistant token

In Home Assistant:

1. Open the user profile.
2. Open the Security tab.
3. Under Long-lived access tokens, select Create token.
4. Name it `Hearth host Mac`.
5. Copy the token once.

Back in Terminal, store it without echoing it. If `$HEARTH_SECRET_DIR`
is unset, the redirect would target `/home-assistant-token` on the
read-only system root, so guard explicitly:

```bash
: "${HEARTH_SECRET_DIR:?must be set - re-run section 2 in this shell}"
read -s "HEARTH_HA_TOKEN_INPUT?Paste the Home Assistant token: "
printf '\n'
printf '%s\n' "$HEARTH_HA_TOKEN_INPUT" > "$HEARTH_SECRET_DIR/home-assistant-token"
chmod 600 "$HEARTH_SECRET_DIR/home-assistant-token"
unset HEARTH_HA_TOKEN_INPUT
echo "Wrote Home Assistant token to $HEARTH_SECRET_DIR/home-assistant-token (600)"
```

Set the URL for the current Terminal session:

```bash
export HEARTH_HA_URL=http://homeassistant.local:8123
export HEARTH_HA_TOKEN="$(< "$HEARTH_SECRET_DIR/home-assistant-token")"
```

If `.local` does not resolve, replace it with the VM IP address.

Verify authentication:

```bash
curl -fsS "$HEARTH_HA_URL/api/" \
  -H "Authorization: Bearer $HEARTH_HA_TOKEN" | jq .
```

Expected response:

```json
{
  "message": "API running."
}
```

List entity IDs without printing the token:

```bash
curl -fsS "$HEARTH_HA_URL/api/states" \
  -H "Authorization: Bearer $HEARTH_HA_TOKEN" \
  | jq -r '.[].entity_id' \
  | sort
```

This probe only verifies Home Assistant access. Hearth's live adapter imports
entities for discovery. Physical dispatch stays behind the executor and is
limited to the exact IDs in `HEARTH_HA_ACTUATION_ALLOWLIST`. The two approved
pilot devices currently use the active SmartThings entities
`light.fixture_room_lamp_alpha` and
`light.fixture_room_lamp_beta`. The similarly named Hue entities are
disabled in Home Assistant. Do not add the Hue room group or other imported
devices without separate review and authorization.

## 12. Start Hearth

Fixture mode is the default. For live discovery, configure the HA URL and token
and set `HEARTH_FIXTURE_MODE=0`. The approved pilot allowlist is restricted to
the two individual master-bedroom lamp entity IDs listed above. The local PWA uses an admin session when the
control service is bound to loopback and started with `HEARTH_ALLOW_DEV_ADMIN=1`.
The `Run with Hearth` button is the user's action request; an eligible proposal
with a server receipt goes straight to the executor without an extra browser
confirmation. The executor still rejects entities outside the exact allowlist.

Create a session secret and database location. The same `$HEARTH_SECRET_DIR`
guard applies:

```bash
umask 077
: "${HEARTH_SECRET_DIR:?must be set - re-run section 2 in this shell}"
openssl rand -hex 32 > "$HEARTH_SECRET_DIR/hearth-session-secret"
chmod 600 "$HEARTH_SECRET_DIR/hearth-session-secret"
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
export HEARTH_SQLITE_PATH="$HEARTH_DATA_DIR/hearth.sqlite"
export HEARTH_HOST=127.0.0.1
export HEARTH_PORT=8787
export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
echo "Wrote session secret to $HEARTH_SECRET_DIR/hearth-session-secret (600)"
```

`HEARTH_SQLITE_PATH` stores executor records and saved routine/hold schedules
in the same SQLite database. Keep this file under the installation-local data
directory so routines survive a control-service restart. Routines created in
the PWA store their selected IANA time zone; older records without a time zone
use UTC. Hearth runs only the occurrence due in the current minute; offline
occurrences are skipped. A pending fire left by a crash is marked skipped
during recovery because Hearth cannot know whether the prior process sent its
device command. It is never blindly replayed.

Open another Terminal window and start the control API. If you
persisted the HEARTH_*_DIR lines to ~/.zshenv, the directory exports
below are redundant; they are written here for clarity when running
the API in a fresh shell.

```bash
export HEARTH_REPO="$HOME/src/hearth"
cd "$HEARTH_REPO"
export HEARTH_RUNTIME_ROOT="$HOME/Library/Application Support/Hearth"
export HEARTH_DATA_DIR="$HEARTH_RUNTIME_ROOT/data"
export HEARTH_SECRET_DIR="$HEARTH_RUNTIME_ROOT/secrets"
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
export HEARTH_SQLITE_PATH="$HEARTH_DATA_DIR/hearth.sqlite"
export HEARTH_HOST=127.0.0.1
export HEARTH_PORT=8787
export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
export HEARTH_GLINER2_CHECKPOINT="$HEARTH_RUNTIME_ROOT/models/gliner2/hearth-pilot-20260925-v5/merged"
export HEARTH_FIXTURE_MODE=0
export HEARTH_HA_URL=http://127.0.0.1:8123
export HEARTH_HA_TOKEN="$(< "$HEARTH_SECRET_DIR/home-assistant-token")"
export HEARTH_OPENCLAW_URL=http://127.0.0.1:18789
export HEARTH_GATEWAY_TOKEN="$(< "$HEARTH_SECRET_DIR/openclaw-gateway-token")"
export HEARTH_HA_ACTUATION_ALLOWLIST="$(< "$HEARTH_SECRET_DIR/hearth-actuation-allowlist")"
export HEARTH_ALLOW_DEV_ADMIN=1
node apps/control/dist/src/main.js
```

For local development, open another Terminal window and start the PWA:

```bash
export HEARTH_REPO="$HOME/src/hearth"
cd "$HEARTH_REPO"
pnpm --filter @hearth/web exec vite --host 127.0.0.1
```

Verify the current application:

```bash
curl -fsS http://127.0.0.1:8787/healthz | jq .
curl -fsS http://127.0.0.1:8787/readyz | jq .
open http://127.0.0.1:5173
```

For a built same-origin gateway, run `pnpm --filter @hearth/web start:prod`
with `HEARTH_WEB_HOST=127.0.0.1`, `HEARTH_WEB_PORT=5174`, and
`HEARTH_TAILSCALE_ALLOWED_USERS` set to the exact approved tailnet login
identity. Tailscale Serve must target this loopback gateway on port 5174. Do
not expose port 8787, Home Assistant, OpenClaw, Bonsai, or GLiNER2 through
Serve.

Run the repository doctor with the same environment:

```bash
cd "$HEARTH_REPO"
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
export HEARTH_SQLITE_PATH="$HEARTH_DATA_DIR/hearth.sqlite"
export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
./scripts/doctor.sh
node apps/control/dist/src/main.js doctor
```

The doctor checks GLiNER2, Home Assistant, and the authenticated OpenClaw
Gateway. The `/readyz` response also confirms how many controllable devices
Hearth imported.

### Managed startup and recovery

The macOS LaunchAgent installer starts the local Bonsai server, GLiNER2
sidecar, live control service, and production PWA at login. Each job uses
`KeepAlive` with a 10-second restart throttle. Tokens and the exact actuator
allowlist are read from owner-only files under the runtime secrets directory;
they are not copied into LaunchAgent property lists. Control and PWA bind only
to `127.0.0.1`. OpenClaw keeps its existing LaunchAgent, and Home Assistant
keeps its existing Docker restart policy.

Stop the existing foreground services gracefully and confirm ports 8080, 8770,
8787, and 5174 are free before installing the agents. The installer refuses
to start duplicate listeners:

```bash
cd "$HEARTH_REPO"
node scripts/macos/launch-agents.mjs install
```

The LaunchAgents run in the logged-in user's GUI session, including while the
screen is locked. The user must remain logged in, and Docker Desktop must start
at login for the existing Home Assistant container's restart policy to take
effect. Tailscale Serve should use its persistent background mode after the
identity allowlist and tailnet grants are reviewed. Remove the Hearth agents
without deleting runtime data or secrets with:

```bash
node scripts/macos/launch-agents.mjs uninstall
```

## 13. Implementation status and remaining gates

Updated 2026-09-27. Stage 0, Stage 1 fixture checks, and the frozen Stage 3
synthetic corpus checks pass on this host. The running GLiNER2 sidecar uses the
local v5 LoRA pilot. Separate v7 pilot results are diagnostics, not the Stage 3
gate.

1. **Complete:** Home Assistant adapter, with fixture mode as the default and live dispatch gated by the executor and explicit entity allowlist.
2. **Complete:** Environment-driven fixture/live adapter selection in `apps/control/src/main.ts`.
3. **Complete:** `HEARTH_EXTRACT_URL` is passed to the interpreter.
4. **Complete:** GLiNER2 schema translation is covered against the pinned 2.0.0 package.
5. **Complete:** `packages/openclaw-adapter/` uses the pinned Gateway WebSocket client, loopback-only, without actuation tools or household access.
6. **Complete:** `BonsaiProvider` sends a compact output contract and applies strict server-side validation. Accepted agent runs are not retried.
7. **Remaining:** Complete the Bonsai lock with exact source revision, checksum, license notices, llama.cpp build details, prompt-template compatibility, and measured peak memory.
8. **Complete for Stage 0:** doctor verifies GLiNER2 health, Home Assistant reachability, and the authenticated OpenClaw Gateway handshake. Live control is limited to the two user-approved lamp entity IDs.
9. **Complete:** A real local Bonsai interpretation passed Hearth's proposal validation.
10. **Complete for the frozen Stage 3 corpus:** grammar, GLiNER2-only, and
    combined evaluations each pass 200 cases with 150/150 exact supported
    cases and zero wrong-target, unauthorized, or dropped-exclusion outcomes.

### Items landed in v3.0.10 (this branch)

The following items from the punch list above have been implemented and unit-tested against fixture gates (live-resource tests still need to be run on the deployment Mac; see below for operator commands):

1. **Real HA adapter (item 1):** `packages/ha-adapter/src/live.ts` uses REST for `/api/`, `/api/states`, and `/api/services/<domain>/<service>`, and the authenticated WebSocket API for the area, device, and entity registries plus state subscriptions. Registry areas, entity registry, and states are mapped into Hearth's `DeviceRecord` / `Room` shapes. Sensors are filtered out of `listDevices()` because they have no commands. The `HAConnectionPool` accepts an `(seed, 'ha', adapter)` overload so `main.ts` can swap in the live adapter.
2. **Env-driven control service (item 2):** `apps/control/src/main.ts` reads `HEARTH_FIXTURE_MODE` (default `'1'`, safe), `HEARTH_HA_URL`, and `HEARTH_HA_TOKEN`. Live mode is fail-closed: it requires both env vars and a working `probe()` of `HEARTH_HA_URL`.
3. **`HEARTH_EXTRACT_URL` plumbed (item 3):** `main.ts` reads the variable and threads it through `wireControl()` via conditional spread so the interpreter's GLiNER2 provider runs against the real sidecar when set.
4. **GLiNER2 schema translation (item 4):** `apps/extract/hearth_extract/__init__.py` calls the pinned `gliner2==2.0.0` API using `schema=...` (not `entity_types=...`).
5. **`packages/openclaw-adapter/` (item 5):** Loopback-only `OpenClawBonsaiProvider` uses the pinned `@openclaw/gateway-client` and protocol packages over Gateway WebSocket RPC. It grants only the `operator.write` scope needed for agent turns. No actuation tools, shell, browser, general HTTP, household credentials, or executor DB access.
6. **`BonsaiProvider` through the adapter (item 6):** Implements `BonsaiProvider.propose()` + `validateProposal()`. Agent turns use the request ID as an idempotency key. Accepted runs are never resubmitted; timeouts surface as uncertain. Hearth parses the streamed result and applies strict server-side proposal validation. Invalid output fails closed without silent repair.
7. **Model locks (partial):** OpenClaw's version and adapter package locks are verified. Bonsai lock metadata still needs exact source revision, checksum, llama.cpp build details, prompt-template compatibility, license notices, and measured model-server peak memory before release.
8. **Doctor checks for live resources (item 8):** `apps/control/src/main.ts` doctor adds `ha-reachable` (read-only `/api/` probe in live mode) and `openclaw-reachable` (authenticated, loopback-only Gateway WebSocket handshake). `scripts/verify-openclaw-lock.mjs` verifies the lock structure.
9. **Stage 0 round-trip (item 9):** The setup host completed a real local Bonsai interpretation through Hearth's Gateway RPC adapter. The returned JSON passed `validateProposalRaw()` and produced a typed `IntentProposal`. The adapter unit tests also cover request idempotency, stream parsing, and invalid output rejection.
10. **Stage 3 evaluation (item 10):** Complete for the frozen synthetic corpus. The grammar, GLiNER2-only, and combined reports each cover 200 cases, with 150/150 exact supported cases, zero wrong-target admissions, zero unauthorized admissions, zero dropped exclusions, and zero sample failures. The corpus SHA-256 and report metrics are recorded in `docs/gates.md`. A separate Bonsai-only diagnostic was stopped before completion to keep Bonsai available for interactive use; it is not a Stage 3 gate.

### Verified operator evidence and remaining follow-up

The local session grants the PWA admin role for this loopback setup. The executor remains the only dispatch path. Home Assistant exposes distinct entity IDs with repeated friendly names for the two pilot lamps. Room expansion and contract resolution use the exact two user-approved entity routes. The Hue room group and all other imported devices remain excluded from actuation. No bridge reset or re-pairing is needed.

The remaining operator follow-up is:

- **Home Assistant live verification.** The authenticated `/api/` probe passed. The original two-lamp command was run through Hearth's executor after the SmartThings entry reload, and both lamp states were confirmed on.
- **SmartThings event-stream reliability.** On Home Assistant Core 2026.9.3, the SmartThings entry remained loaded while its SSE subscription logged truncated responses and timeouts. Reloading the existing config entry restored state synchronization. Hearth then confirmed the original two-lamp command through its executor. Similar stale-feed symptoms and reload recovery are tracked upstream in [Home Assistant Core issue 158874](https://github.com/home-assistant/core/issues/158874) and [issue 176244](https://github.com/home-assistant/core/issues/176244). No pairing or credential changes were made. If this recurs, inspect the SmartThings integration logs and reload that existing entry from Settings > Devices & services.
- **OpenClaw Gateway live verification.** The pinned Gateway listens on `ws://127.0.0.1:18789`. Hearth uses the pinned OpenClaw Gateway WebSocket client and protocol packages. The setup-host doctor handshake and Bonsai interpretation both pass. The provider refuses non-loopback URLs and checks the Gateway's reported version against the pin.
- **Managed process recovery.** The Hearth Bonsai, GLiNER2, control, and
  production web LaunchAgents are installed. Their listeners are loopback-only,
  and a graceful production web process exit was recovered automatically with
  HTTP 200. A full host logout/login test is still pending.
- **Bonsai lock SHA-256 (item 7, complete the lock).** Run on the deployment host:
  ```
  shasum -a 256 "$HEARTH_MODEL_DIR/Bonsai-27B-Q1_0.gguf"
  ```
  Then patch the SHAs into `models/bonsai.lock.json` and `packages/openclaw-adapter/src/lock.ts`.
- **Household device review.** Hearth reads 56 HA device records and currently
  enables two verified lamp entities for live actuation. The private review
  sheet records 55 HA device registry IDs, 15 repeated friendly-name groups,
  21 rows without make/model, and no failed state reads. Verify physical
  identity and load for each route before extending the exact allowlist.
- **iPad private access.** The local PWA currently creates an admin session
  and loads device discovery. The Tailscale package install needs local macOS
  administrator authorization, VPN configuration approval, and tailnet sign-in.
  The Mac is locked in the current session, so Serve configuration and actual
  iPad checks remain pending.

## 14. Stop the foreground services

When LaunchAgents are installed, unload them with:

```bash
node scripts/macos/launch-agents.mjs uninstall
```

For foreground development sessions, stop Bonsai, GLiNER2, Hearth control, or
the PWA with:

```text
Control-C
```

Stop the OpenClaw LaunchAgent with:

```bash
openclaw gateway stop
```

If you used the VirtualBox route for Home Assistant (section 10b), shut
down the HA VM from Home Assistant (Settings -> System -> Power Button
-> Shut down) or from VirtualBox (Machine -> ACPI Shutdown). Do not
force-stop during database writes. If you used the Docker route
(section 10a), stop the container with `docker stop homeassistant`.

## 15. Primary references

- OpenClaw 2026.9.6 release: <https://github.com/openclaw/openclaw/releases/tag/v2026.9.6>
- OpenClaw non-interactive onboarding: <https://docs.openclaw.ai/cli/onboard>
- OpenClaw macOS Gateway service: <https://docs.openclaw.ai/platforms/mac/bundled-gateway>
- OpenClaw external application integration: <https://docs.openclaw.ai/gateway/external-apps>
- PrismML Bonsai 27B GGUF model: <https://huggingface.co/prism-ml/Bonsai-27B-gguf>
- PrismML Bonsai runtime guide: <https://github.com/PrismML-Eng/Bonsai-demo>
- GLiNER2 local inference: <https://github.com/fastino-ai/GLiNER2>
- Home Assistant macOS installation: <https://www.home-assistant.io/installation/macos>
- Home Assistant authentication API: <https://developers.home-assistant.io/docs/auth_api/>
