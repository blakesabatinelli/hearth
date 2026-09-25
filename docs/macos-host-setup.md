# macOS host setup

This runbook targets an Apple Silicon Mac and the Hearth source tree. It installs and starts:

- Bonsai 27B 1-bit through `llama-server` with Metal acceleration.
- OpenClaw 2026.9.6 configured to use that local Bonsai server.
- The Hearth GLiNER2 sidecar with the pinned GLiNER2 2.0.0 package.
- Home Assistant OS in a local virtual machine, or an existing Home Assistant instance.
- The current Hearth control API and PWA in fixture mode.

## Important current limitation

The commands below bring all four external components up and verify each one independently. They do not make this revision of Hearth use all four components end to end.

The current source has these blockers:

1. `apps/control/src/main.ts` always constructs `HAConnectionPool` with the synthetic fixture. `HEARTH_HA_URL`, `HEARTH_HA_TOKEN`, and `HEARTH_FIXTURE_MODE` are not read during normal startup.
2. `apps/control/src/main.ts` does not pass `HEARTH_EXTRACT_URL` to `wireControl()`. The variable is read only by the `doctor` subcommand.
3. No real `BonsaiProvider` implementation exists. `wireControl()` defaults Bonsai to `null`.
4. `packages/openclaw-adapter/` does not exist. Hearth cannot yet call the OpenClaw Gateway.
5. `models/bonsai.lock.json` still has `TBD` artifact and runtime fields.
6. The GLiNER2 `/extract` implementation has not been proven against the pinned package in a live environment.

Do not claim a complete Hearth integration until those six items are implemented and the Stage 0 and Stage 3 gates pass. The final section lists the required code work.

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

```bash
export HEARTH_RUNTIME_ROOT="$HOME/Library/Application Support/Hearth"
export HEARTH_MODEL_DIR="$HEARTH_RUNTIME_ROOT/models/bonsai"
export HEARTH_DATA_DIR="$HEARTH_RUNTIME_ROOT/data"
export HEARTH_LOG_DIR="$HEARTH_RUNTIME_ROOT/logs"
export HEARTH_SECRET_DIR="$HEARTH_RUNTIME_ROOT/secrets"

mkdir -p "$HEARTH_MODEL_DIR"
mkdir -p "$HEARTH_DATA_DIR"
mkdir -p "$HEARTH_LOG_DIR"
mkdir -p "$HEARTH_SECRET_DIR"
chmod 700 "$HEARTH_RUNTIME_ROOT" "$HEARTH_SECRET_DIR"
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
  --ctx-size 4096 \
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

Create a Gateway token without printing it:

```bash
umask 077
openssl rand -hex 32 > "$HEARTH_SECRET_DIR/openclaw-gateway-token"
export OPENCLAW_GATEWAY_TOKEN="$(< "$HEARTH_SECRET_DIR/openclaw-gateway-token")"
```

Configure OpenClaw to use the already-running Bonsai server:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --mode local \
  --auth-choice llama-cpp-existing-server \
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
      "entity_types": ["device_target", "room_target"],
      "classification_labels": ["on", "off"],
      "relations": [],
      "known_aliases": []
    }
  }' | jq .
```

Do not treat `/health` alone as proof. The `/extract` request must return HTTP 200 and a body containing the same `request_id` and `original_utterance`. If it returns HTTP 500, the sidecar's GLiNER2 2.0.0 API call needs to be corrected before Hearth can use it.

## 10. Install Home Assistant OS

If the household already has Home Assistant, do not create a second instance and do not re-pair any Hue or SmartThings devices. Skip to the token section and use the existing URL.

For a new local installation on Apple Silicon, use the supported Home Assistant OS virtual-machine route.

Install VirtualBox:

```bash
brew install --cask virtualbox
open -a VirtualBox
```

In a browser, open the official macOS installation page:

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

Complete Home Assistant onboarding in the browser. Add the existing Hue and SmartThings integrations through Home Assistant. Do not reset bridges, remove existing accounts, or re-pair devices.

## 11. Create and verify a Home Assistant token

In Home Assistant:

1. Open the user profile.
2. Open the Security tab.
3. Under Long-lived access tokens, select Create token.
4. Name it `Hearth host Mac`.
5. Copy the token once.

Back in Terminal, store it without echoing it:

```bash
read -s "HEARTH_HA_TOKEN_INPUT?Paste the Home Assistant token: "
printf '\n'
printf '%s\n' "$HEARTH_HA_TOKEN_INPUT" > "$HEARTH_SECRET_DIR/home-assistant-token"
chmod 600 "$HEARTH_SECRET_DIR/home-assistant-token"
unset HEARTH_HA_TOKEN_INPUT
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

Do not send service calls during setup. Device actuation remains fixture-only until Hearth has a real adapter, an imported registry, a reviewed allowlist, and evidence policies.

## 12. Start the current Hearth application

The current application starts only with the synthetic Home Assistant fixture and mock GLiNER2 provider. This is useful for verifying the checked-in code, but it is not the live integration.

Create a session secret and database location:

```bash
umask 077
openssl rand -hex 32 > "$HEARTH_SECRET_DIR/hearth-session-secret"
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
export HEARTH_SQLITE_PATH="$HEARTH_DATA_DIR/hearth.sqlite"
export HEARTH_HOST=127.0.0.1
export HEARTH_PORT=8787
export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
```

Open another Terminal window and start the control API:

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
node apps/control/dist/src/main.js
```

Open another Terminal window and start the PWA:

```bash
export HEARTH_REPO="$HOME/src/hearth"
cd "$HEARTH_REPO"
pnpm --filter @hearth/web dev -- --host 127.0.0.1
```

Verify the current application:

```bash
curl -fsS http://127.0.0.1:8787/healthz | jq .
curl -fsS http://127.0.0.1:8787/readyz | jq .
open http://127.0.0.1:5173
```

Run the repository doctor with the same environment:

```bash
cd "$HEARTH_REPO"
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
export HEARTH_SQLITE_PATH="$HEARTH_DATA_DIR/hearth.sqlite"
export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
./scripts/doctor.sh
node apps/control/dist/src/main.js doctor
```

The doctor can prove reachability of GLiNER2. It cannot prove that normal control requests use the sidecar because the current startup path does not pass the URL into `wireControl()`.

## 13. Required implementation before live Hearth use

These are code changes, not additional setup commands:

1. Implement a real Home Assistant adapter with REST and WebSocket support. It must import areas, devices, entities, capabilities, availability, and state versions. Dispatch must remain behind the executor.
2. Make `apps/control/src/main.ts` honor `HEARTH_FIXTURE_MODE`, `HEARTH_HA_URL`, and `HEARTH_HA_TOKEN`. Default to fixture mode unless live mode is explicitly selected.
3. Pass `HEARTH_EXTRACT_URL` into `wireControl({ gliner2_http_url: ... })`.
4. Correct and test the GLiNER2 schema translation against the pinned GLiNER2 2.0.0 package.
5. Add `packages/openclaw-adapter/` as a restricted Gateway client with no actuation tools, shell, browser, general HTTP, household credentials, or executor database access.
6. Implement `BonsaiProvider` through that OpenClaw adapter. Require schema-constrained output, validate again server-side, allow at most one formatting retry, and fail closed.
7. Update `models/bonsai.lock.json` with the exact revision, filename, SHA-256, Apache-2.0 notices, llama.cpp version or commit, Metal build profile, context, template compatibility, and measured peak memory.
8. Add startup and doctor checks for Bonsai, OpenClaw, Home Assistant, and the actual selected providers.
9. Run the Stage 0 real OpenClaw-to-Bonsai round trip.
10. Run the Stage 3 evaluation with at least 200 reviewed cases and zero admitted wrong-target or unauthorized proposals.

Until those changes land, keep Home Assistant read-only from Hearth and keep household actuation disabled.

## 14. Stop the foreground services

In each Terminal window running Bonsai, GLiNER2, Hearth control, or the PWA, press:

```text
Control-C
```

Stop the OpenClaw LaunchAgent with:

```bash
openclaw gateway stop
```

Shut down the Home Assistant VM from Home Assistant or VirtualBox. Do not force-stop it during database writes.

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
