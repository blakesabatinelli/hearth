# syntax=docker/dockerfile:1.7
# Hearth - multi-stage build.
#
# Stage 1 (build): compile the entire pnpm workspace.
# Stage 2 (runtime): Node 22 slim + Python 3.11 slim, copy built artifacts.

ARG NODE_VERSION=22.11.0
ARG PYTHON_VERSION=3.11-slim

# -----------------------------------------------------------------------
# Build stage: compiles TS, prepares Python sidecar venv.
# -----------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# pnpm via corepack (pinned in package.json).
RUN corepack enable

# Install build deps for better-sqlite3 + gliner2.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    build-essential ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first (better layer cache).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./

# Copy package manifests so pnpm install can resolve everything.
COPY packages/contracts/package.json packages/contracts/
COPY packages/registry/package.json packages/registry/
COPY packages/ha-adapter/package.json packages/ha-adapter/
COPY packages/executor/package.json packages/executor/
COPY packages/interpreter/package.json packages/interpreter/
COPY packages/extractor/package.json packages/extractor/
COPY packages/scheduler/package.json packages/scheduler/
COPY apps/control/package.json apps/control/
COPY apps/web/package.json apps/web/
COPY apps/extract/pyproject.toml apps/extract/

RUN pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY packages/ packages/
COPY apps/ apps/
COPY scripts/ scripts/
COPY models/ models/

# Build every workspace package.
RUN pnpm -r --filter './packages/*' --filter './apps/*' build

# Build the Python sidecar (optional - the resulting image still works if
# gliner2 isn't installed; the sidecar returns 503 in that case).
RUN cd apps/extract && python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir --upgrade pip wheel && \
    .venv/bin/pip install --no-cache-dir 'gliner2[local]>=2.0.0,<3.0.0' 'fastapi>=0.115' 'uvicorn[standard]>=0.30' || \
    echo 'WARN: gliner2 install failed; sidecar will run in degraded mode' && \
    echo 'venv marker' > .venv/.installed

# -----------------------------------------------------------------------
# Runtime stage: minimal image with both runtimes.
# -----------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates tini curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Copy compiled artifacts from build stage.
COPY --from=build /app /app

# Create non-root user for runtime.
RUN groupadd --system hearth && useradd --system --gid hearth --home /app hearth && \
    chown -R hearth:hearth /app
USER hearth

EXPOSE 8787 5173

# tini: PID 1 reaper.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default: start the control service. The compose file overrides per-service.
CMD ["node", "apps/control/dist/src/main.js"]