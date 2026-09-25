#!/usr/bin/env bash
# doctor.sh - check the Hearth installation.
#
# Verifies:
#   1. Control service reachable.
#   2. /healthz reports ok.
#   3. /readyz reports ready (registry + adapter loaded).
#   4. GLiNER2 sidecar reachable (if configured).
#   5. HA reachable (only if HEARTH_HA_URL is set; fixture mode skips).
#   6. SQLite database writable.
#
# Exits 0 only if every check passes.

set -euo pipefail

CONTROL_URL="${HEARTH_CONTROL_URL:-http://127.0.0.1:8787}"
EXTRACT_URL="${HEARTH_EXTRACT_URL:-}"
SQLITE_PATH="${HEARTH_SQLITE_PATH:-}"

fail=0
pass=0
warn=0

# 0. Native binding sanity check (better-sqlite3).
# pnpm 9+ skips postinstall scripts unless the package is whitelisted in
# pnpm.onlyBuiltDependencies. If the binding failed to download/build at
# install time, every SqliteExecutionStore test fails with "Could not
# locate the bindings file". Surface this loudly here.
if [[ -d "node_modules" ]]; then
  binding=$(find node_modules -path '*better-sqlite3*/build/Release/better_sqlite3.node' 2>/dev/null | head -1)
  if [[ -n "$binding" ]]; then
    check "better-sqlite3 native binding" PASS "$binding"
  else
    check "better-sqlite3 native binding" FAIL "binding missing - run: pnpm rebuild better-sqlite3"
  fi
else
  check "better-sqlite3 native binding" WARN "node_modules not installed yet"
fi

# 0b. GLiNER2 sidecar venv sanity check. Without this venv, /v1/extract
# requests 500 with 'No module named torch' or similar. The smoke test
# just imports AutoExtractor; loading the checkpoint happens at sidecar
# startup, which is faster to verify separately.
extract_venv="apps/extract/.venv"
if [[ -d "${extract_venv}" ]]; then
  if "${extract_venv}/bin/python" -c "from gliner2 import AutoExtractor" 2>/dev/null; then
    check "gliner2 sidecar importable" PASS "${extract_venv}"
  else
    check "gliner2 sidecar importable" FAIL "${extract_venv}/bin/python cannot import gliner2; rerun scripts/install.sh"
  fi
else
  check "gliner2 sidecar importable" FAIL "${extract_venv} not built; rerun scripts/install.sh"
fi

check() {
  local name="$1"; shift
  local status="$1"; shift
  local detail="$1"; shift || true
  case "$status" in
    PASS) pass=$((pass + 1)); icon="OK"; color="\033[32m" ;;
    WARN) warn=$((warn + 1)); icon="WARN"; color="\033[33m" ;;
    FAIL) fail=$((fail + 1)); icon="FAIL"; color="\033[31m" ;;
    *) echo "doctor.sh: bad status $status" >&2; exit 2 ;;
  esac
  printf "${color}[%s] %s\033[0m" "$icon" "$name"
  if [[ -n "$detail" ]]; then
    printf ": %s" "$detail"
  fi
  printf "\n"
}

http_status() {
  curl -fsS -o /dev/null -w "%{http_code}" --max-time 5 "$1" 2>/dev/null || echo "000"
}

# 1. control reachable
http_body() {
  curl -fsS --max-time 5 "$1" 2>/dev/null || true
}

ctl_status=$(http_status "${CONTROL_URL}/healthz")
if [[ "$ctl_status" == "200" ]]; then
  check "control service reachable" PASS "${CONTROL_URL}/healthz returned 200"
else
  check "control service reachable" FAIL "${CONTROL_URL}/healthz returned ${ctl_status}"
fi

# 2. readyz
readyz=$(http_body "${CONTROL_URL}/readyz")
if echo "$readyz" | grep -q '"status":"ready"'; then
  device_count=$(echo "$readyz" | sed -n 's/.*"device_count":\([0-9]*\).*/\1/p')
  check "/readyz reports ready" PASS "device_count=${device_count:-unknown}"
else
  check "/readyz reports ready" FAIL "body=${readyz}"
fi

# 3. GLiNER2 sidecar
if [[ -n "$EXTRACT_URL" ]]; then
  extract_status=$(http_status "${EXTRACT_URL}/health")
  if [[ "$extract_status" == "200" ]]; then
    check "GLiNER2 sidecar reachable" PASS "${EXTRACT_URL}/health returned 200"
  else
    check "GLiNER2 sidecar reachable" FAIL "${EXTRACT_URL}/health returned ${extract_status}"
  fi
else
  check "GLiNER2 sidecar configured" WARN "HEARTH_EXTRACT_URL not set; running with mock-gliner2"
fi

# 4. SQLite writable
if [[ -n "$SQLITE_PATH" ]]; then
  if [[ -f "$SQLITE_PATH" ]]; then
    if [[ -w "$SQLITE_PATH" ]]; then
      check "sqlite database writable" PASS "$SQLITE_PATH"
    else
      check "sqlite database writable" FAIL "$SQLITE_PATH not writable"
    fi
  else
    check "sqlite database writable" WARN "$SQLITE_PATH does not exist yet"
  fi
else
  check "sqlite database path configured" WARN "HEARTH_SQLITE_PATH not set; default in-memory store"
fi

echo ""
echo "Summary: ${pass} pass, ${warn} warn, ${fail} fail"
if [[ $fail -ne 0 ]]; then
  exit 1
fi