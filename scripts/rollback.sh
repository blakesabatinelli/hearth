#!/usr/bin/env bash
# rollback.sh - restore the previous Hearth deployment.
#
# Strategy: keep the last 3 successful deployments as named images
# (`hearth:current`, `hearth:previous`, `hearth:backup`) and rotate them
# on every `docker compose up`. This script tags the previous image as
# `hearth:rollback` and restarts the stack against it.

set -euo pipefail

INSTALL_DIR="${HEARTH_DIR:-/opt/hearth}"

main() {
  cd "${INSTALL_DIR}"
  if ! command -v docker >/dev/null 2>&1; then
    echo "rollback.sh: docker not found" >&2
    exit 1
  fi
  if ! docker image inspect hearth:previous >/dev/null 2>&1; then
    echo "rollback.sh: no 'hearth:previous' image found - nothing to roll back to" >&2
    exit 1
  fi

  echo ">>> stopping current stack"
  docker compose down --remove-orphans || true

  echo ">>> promoting hearth:previous to hearth:current"
  docker tag hearth:previous hearth:current

  echo ">>> restarting stack on previous image"
  docker compose --profile with-extract up -d

  echo ">>> rollback complete; current image:"
  docker image inspect hearth:current --format '{{.Id}} ({{.CreatedAt}})'
}

main "$@"