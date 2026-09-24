#!/usr/bin/env node
/**
 * hearth-control: the HTTP API service.
 *
 * Reads environment, wires the registry + HA adapter + executor + interpreter
 * into a Fastify app, calls reconcileOnStartup(), then listens.
 *
 * Env vars:
 *   HEARTH_PORT                  listen port (default 8787)
 *   HEARTH_HOST                  listen host (default 0.0.0.0)
 *   HEARTH_SESSION_SECRET        HMAC secret for session cookies (REQUIRED in prod)
 *   HEARTH_SQLITE_PATH           path to executor SQLite database (default :memory:)
 *   HEARTH_FIXTURE_MODE          if "1", use the in-memory fake-HA fixture (default 1)
 */
import {
  SystemClock,
  InMemoryExecutionStore,
  type ExecutionStore,
} from '@hearth/executor';
import {
  HAConnectionPool,
  loadDefaultFixture,
} from '@hearth/ha-adapter';
import { RegistryOverlay } from '@hearth/registry';
import { wireControl } from './wiring.js';

async function makeStore(sqlite_path: string): Promise<ExecutionStore> {
  if (sqlite_path === ':memory:') {
    return new InMemoryExecutionStore();
  }
  // Dynamic import so better-sqlite3 is not required when running with
  // the default in-memory store (faster dev boot, no native binding).
  type DatabaseCtor = new (filename: string) => unknown;
  const mod = await import('better-sqlite3') as unknown as { default?: DatabaseCtor };
  const Database = (mod.default ?? (mod as unknown as DatabaseCtor));
  const db = new Database(sqlite_path) as import('better-sqlite3').Database;
  const { SqliteExecutionStore } = await import('@hearth/executor');
  return new SqliteExecutionStore({ db });
}

async function main(): Promise<void> {
  const port = Number(process.env.HEARTH_PORT ?? 8787);
  const host = process.env.HEARTH_HOST ?? '0.0.0.0';
  const session_secret = process.env.HEARTH_SESSION_SECRET ?? 'dev-secret-change-me';
  const sqlite_path = process.env.HEARTH_SQLITE_PATH ?? ':memory:';

  const fixture = loadDefaultFixture();
  const registry = new RegistryOverlay({
    devices: fixture.devices,
    rooms: fixture.rooms,
    entity_version: 1,
    scene_versions: {},
  });

  const pool = new HAConnectionPool(fixture);
  const adapter = pool.getActive();

  const store = await makeStore(sqlite_path);
  const clock = new SystemClock();

  const wired = await wireControl({
    registry,
    adapter,
    store,
    clock,
    session_secret,
  });

  // Recovery: load interrupted contracts (dispatching / sent-unconfirmed)
  // and reconcile. No-op if the store is empty.
  try {
    await wired.executor.reconcileOnStartup();
  } catch (err) {
    // Don't kill the process on first boot if recovery fails; surface to logs.
    // eslint-disable-next-line no-console
    console.error('[hearth-control] reconcileOnStartup failed:', (err as Error).message);
  }

  await wired.app.listen({ port, host });

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[hearth-control] received ${signal}, shutting down`);
    try {
      await wired.app.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[hearth-control] shutdown error:', (err as Error).message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[hearth-control] fatal:', err);
  process.exit(1);
});