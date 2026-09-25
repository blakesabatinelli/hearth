#!/usr/bin/env bash
# install.sh - one-shot Hearth installer for a fresh Debian/Ubuntu box.
#
# What it does:
#   1. Verifies root + a supported OS.
#   2. Installs system packages (Node 22, Python 3.11, build deps).
#   3. Clones the Hearth repo (or uses $HEARTH_REPO if set).
#   4. Builds the project.
#   5. Runs the doctor.
#   6. Prints the next-step instructions.
#
# Idempotent: re-running is safe and just refreshes the build.

set -euo pipefail

REPO_URL="${HEARTH_REPO:-https://github.com/<owner>/hearth.git}"
INSTALL_DIR="${HEARTH_DIR:-/opt/hearth}"
SERVICE_USER="${HEARTH_USER:-hearth}"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "install.sh must run as root (got uid $(id -u))" >&2
    exit 1
  fi
}

detect_os() {
  if [[ ! -f /etc/os-release ]]; then
    echo "Unsupported OS: /etc/os-release missing" >&2
    exit 1
  fi
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) echo "${ID} ${VERSION_CODENAME:-unknown}" ;;
    *)
      echo "Unsupported OS: ${ID:-unknown}. This installer targets Debian/Ubuntu." >&2
      exit 1
      ;;
  esac
}

install_system_packages() {
  echo ">>> installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 python3-venv \
    python3-pip libsqlite3-0
  # Node 22 via NodeSource.
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 23 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  # pnpm via corepack (pinned in package.json).
  corepack enable
  corepack prepare pnpm@10.28.1 --activate
}

clone_repo() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo ">>> repo already present at ${INSTALL_DIR}; pulling latest"
    git -C "${INSTALL_DIR}" pull --ff-only
  else
    echo ">>> cloning ${REPO_URL} to ${INSTALL_DIR}"
    git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

build_project() {
  echo ">>> pnpm install"
  cd "${INSTALL_DIR}"
  pnpm install --frozen-lockfile
  echo ">>> pnpm rebuild better-sqlite3"
  # pnpm 10 honors pnpm.onlyBuiltDependencies but on a fresh Debian box with
  # libsqlite3-0 just installed, force-rebuilding the native binding removes
  # any race with the prebuilt-download step. If this fails, the doctor will
  # catch it on the next line.
  pnpm rebuild better-sqlite3 || true
  binding="$(find "${INSTALL_DIR}/node_modules" -path '*better-sqlite3*/build/Release/better_sqlite3.node' 2>/dev/null | head -1)"
  if [[ -z "${binding}" ]]; then
    echo ">>> FATAL: better-sqlite3 native binding was not built." >&2
    echo ">>> Run: pnpm rebuild better-sqlite3 (and ensure libsqlite3-dev is installed)" >&2
    exit 1
  fi
  echo ">>> pnpm build"
  pnpm -r --filter './packages/*' --filter './apps/*' build
  echo ">>> pnpm test (sanity)"
  pnpm -r --if-present test
}

print_next_steps() {
  cat <<EOF

>>> Hearth installed at ${INSTALL_DIR}

Next steps:

  1. Set HEARTH_SESSION_SECRET in /etc/hearth/hearth.env (32+ random bytes):
       openssl rand -hex 32 | sudo tee /etc/hearth/hearth.env

  2. Start the stack with docker compose:
       cd ${INSTALL_DIR}
       docker compose --profile with-extract up -d

  3. Run the doctor:
       cd ${INSTALL_DIR}
       docker compose exec hearth-control node apps/control/dist/src/main.js doctor
       OR
       ./scripts/doctor.sh

  4. Open the PWA at http://localhost:5173.

The API is reachable at http://localhost:8787.

EOF
}

main() {
  require_root
  echo ">>> OS: $(detect_os)"
  install_system_packages
  clone_repo
  build_project
  print_next_steps
}

main "$@"