#!/bin/zsh
set -euo pipefail
umask 077

service_name=${1:?expected service name}
repo=${HEARTH_REPO:?HEARTH_REPO is required}
runtime=${HEARTH_RUNTIME_ROOT:?HEARTH_RUNTIME_ROOT is required}
secret_dir="$runtime/secrets"
log_dir="$runtime/logs"

mkdir -p -m 700 "$log_dir"
chmod 700 "$log_dir"
if [[ -r "$runtime/live-env.sh" ]]; then
  source "$runtime/live-env.sh"
fi

case "$service_name" in
  bonsai)
    model="$runtime/models/bonsai/Bonsai-27B-Q1_0.gguf"
    exec /opt/homebrew/bin/llama-server \
      --model "$model" \
      --alias bonsai-27b-q1 \
      --host 127.0.0.1 \
      --port 8080 \
      --ctx-size 16384 \
      --n-gpu-layers 99 \
      --parallel 1 \
      --reasoning-budget 256
    ;;
  extract)
    export HEARTH_GLINER2_CHECKPOINT="$runtime/models/gliner2/hearth-pilot-20260925-v5/merged"
    export HEARTH_EXTRACT_HOST=127.0.0.1
    export HEARTH_EXTRACT_PORT=8770
    exec "$repo/apps/extract/.venv/bin/hearth-extract"
    ;;
  control)
    : "${HEARTH_HA_URL:=http://127.0.0.1:8123}"
    export HEARTH_FIXTURE_MODE=0
    export HEARTH_HA_URL
    export HEARTH_HA_TOKEN="$(< "$secret_dir/home-assistant-token")"
    export HEARTH_SESSION_SECRET="$(< "$secret_dir/hearth-session-secret")"
    export HEARTH_GATEWAY_TOKEN="$(< "$secret_dir/openclaw-gateway-token")"
    export HEARTH_HA_ACTUATION_ALLOWLIST="$(< "$secret_dir/hearth-actuation-allowlist")"
    : "${HEARTH_HA_TOKEN:?Home Assistant token is empty}"
    : "${HEARTH_SESSION_SECRET:?Hearth session secret is empty}"
    : "${HEARTH_GATEWAY_TOKEN:?OpenClaw Gateway token is empty}"
    : "${HEARTH_HA_ACTUATION_ALLOWLIST:?The exact device allowlist is empty}"
    mkdir -p -m 700 "$runtime/data"
    export HEARTH_SQLITE_PATH="$runtime/data/hearth.sqlite"
    export HEARTH_HOST=127.0.0.1
    export HEARTH_PORT=8787
    export HEARTH_EXTRACT_URL=http://127.0.0.1:8770
    export HEARTH_GLINER2_CHECKPOINT="$runtime/models/gliner2/hearth-pilot-20260925-v5/merged"
    export HEARTH_OPENCLAW_URL=http://127.0.0.1:18789
    export HEARTH_ALLOW_DEV_ADMIN=1
    exec /opt/homebrew/opt/node@24/bin/node "$repo/apps/control/dist/src/main.js"
    ;;
  web)
    export HEARTH_WEB_HOST=127.0.0.1
    export HEARTH_WEB_PORT=5174
    export HEARTH_CONTROL_URL=http://127.0.0.1:8787
    if [[ -r "$secret_dir/hearth-tailscale-allowed-users" ]]; then
      export HEARTH_TAILSCALE_ALLOWED_USERS="$(< "$secret_dir/hearth-tailscale-allowed-users")"
    else
      export HEARTH_TAILSCALE_ALLOWED_USERS=
    fi
    exec /opt/homebrew/opt/node@24/bin/node "$repo/apps/web/server.mjs"
    ;;
  *)
    print -u2 "unknown Hearth service: $service_name"
    exit 64
    ;;
esac
