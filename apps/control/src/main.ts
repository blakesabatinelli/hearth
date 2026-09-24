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
import { Scheduler, InMemoryScheduleStore, type SchedulerOptions } from '@hearth/scheduler';

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
  // Subcommand: `doctor` runs the diagnostic and exits.
  if (process.argv[2] === 'doctor') {
    const result = await doctor();
    if (result.fail > 0) process.exit(1);
    return;
  }

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

  // v3.0.1: start the scheduler. In-memory only on the current store; the
  // production deployment will swap in a SQLite-backed ScheduleStore
  // pointing at HEARTH_SCHEDULE_DB. The scheduler picks up the live
  // state_version through the adapter.handle getState() lookup, so the
  // executor's stale-context check has the comparison it needs.
  const sched_store = new InMemoryScheduleStore();
  const sched_state: SchedulerOptions = {
    store: sched_store,
    executor: wired.executor,
    registry,
    executor_registry: wired.executor_registry,
    clock,
    state_lookup: async (canonical_id: string): Promise<number> => {
      try {
        const s = await adapter.getState(canonical_id as never);
        return s.state_version;
      } catch {
        return 1;
      }
    },
  };
  const scheduler = new Scheduler(sched_state);
  scheduler.start();
  // eslint-disable-next-line no-console
  console.log('[hearth-control] scheduler started (in-memory store, 30s tick)');

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

// CLI bootstrap: only runs when this file is the actual entry point.
// When imported by tests, `import.meta.url` differs from `process.argv[1]`
// and we skip the bootstrap.
import { fileURLToPath } from 'node:url';
const is_cli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (is_cli) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[hearth-control] fatal:', err);
    process.exit(1);
  });
}

// Doctor subcommand: invoked via `node apps/control/dist/src/main.js doctor`.
// Verifies registry, executor store, adapter, GLiNER2 (if URL set),
// and reports PASS/WARN/FAIL with remediation hints.
//
// Exported separately so tests can import it without triggering main()'s
// listen() call. The CLI calls doctor() before main() if argv[2]=='doctor'.
export async function doctor(): Promise<{ pass: number; warn: number; fail: number }> {
  const checks: Array<{ name: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string }> = [];

  // Check 1: Node version.
  const node_major = Number(process.versions.node.split('.')[0]);
  if (node_major >= 20) {
    checks.push({ name: 'node-runtime', status: 'PASS', detail: `node ${process.versions.node}` });
  } else {
    checks.push({ name: 'node-runtime', status: 'FAIL', detail: `node ${process.versions.node} requires >=20` });
  }

  // Check 2: SQLite path (if configured).
  const sqlite_path = process.env.HEARTH_SQLITE_PATH ?? ':memory:';
  if (sqlite_path === ':memory:') {
    checks.push({ name: 'sqlite', status: 'WARN', detail: 'in-memory store; durable schedules will not survive restart' });
  } else {
    try {
      const fs = await import('node:fs');
      const dir = sqlite_path.substring(0, sqlite_path.lastIndexOf('/'));
      if (dir && !fs.existsSync(dir)) {
        checks.push({ name: 'sqlite', status: 'WARN', detail: `directory ${dir} does not exist yet; will be created on first write` });
      } else {
        checks.push({ name: 'sqlite', status: 'PASS', detail: sqlite_path });
      }
    } catch (err) {
      checks.push({ name: 'sqlite', status: 'FAIL', detail: (err as Error).message });
    }
  }

  // Check 3: Session secret strength.
  const secret = process.env.HEARTH_SESSION_SECRET ?? '';
  if (secret.length >= 32 && secret !== 'dev-secret-change-me') {
    checks.push({ name: 'session-secret', status: 'PASS', detail: `${secret.length} chars` });
  } else if (secret === 'dev-secret-change-me' || secret === '') {
    checks.push({ name: 'session-secret', status: 'FAIL', detail: 'HEARTH_SESSION_SECRET is the dev default; set a 32-byte random secret' });
  } else {
    checks.push({ name: 'session-secret', status: 'WARN', detail: `${secret.length} chars; recommend >= 32` });
  }

  // Check 4: GLiNER2 sidecar (if URL set).
  const extract_url = process.env.HEARTH_EXTRACT_URL ?? '';
  if (extract_url) {
    try {
      const res = await fetch(`${extract_url}/health`);
      if (res.ok) {
        const body = await res.json() as { ready?: boolean };
        checks.push({
          name: 'gliner2-sidecar',
          status: body.ready ? 'PASS' : 'WARN',
          detail: `${extract_url}/health ready=${body.ready}`,
        });
      } else {
        checks.push({ name: 'gliner2-sidecar', status: 'FAIL', detail: `${extract_url}/health returned ${res.status}` });
      }
    } catch (err) {
      checks.push({ name: 'gliner2-sidecar', status: 'FAIL', detail: `${extract_url} unreachable: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: 'gliner2-sidecar', status: 'WARN', detail: 'HEARTH_EXTRACT_URL not set; using mock-gliner2' });
  }

  // Check 5: Model locks present.
  const fs = await import('node:fs');
  for (const lock of ['models/bonsai.lock.json', 'models/gliner2.lock.json']) {
    if (fs.existsSync(lock)) {
      checks.push({ name: lock, status: 'PASS', detail: 'present' });
    } else {
      checks.push({ name: lock, status: 'FAIL', detail: 'missing' });
    }
  }

  // Report.
  let fail = 0;
  let warn = 0;
  let pass = 0;
  for (const c of checks) {
    const icon = c.status === 'PASS' ? '[OK]' : c.status === 'WARN' ? '[WARN]' : '[FAIL]';
    console.log(`${icon} ${c.name}: ${c.detail}`);
    if (c.status === 'PASS') pass += 1;
    else if (c.status === 'WARN') warn += 1;
    else fail += 1;
  }
  console.log('');
  console.log(`Summary: ${pass} pass, ${warn} warn, ${fail} fail`);
  return { pass, warn, fail };
}

// Default export for CLI: only the bootstrap. doctor() is exported
// separately so importing the module for tests does not bind a port.
export default { doctor };