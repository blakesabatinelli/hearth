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
 *   HEARTH_FIXTURE_MODE          "1" (default, safe) or "0" for live HA. Setting
 *                                "0" requires HEARTH_HA_URL and HEARTH_HA_TOKEN,
 *                                else the service refuses to start (fail closed).
 *   HEARTH_HA_URL                base URL of Home Assistant (live mode only).
 *   HEARTH_HA_TOKEN              long-lived HA access token (live mode only).
 *   HEARTH_EXTRACT_URL           base URL of the GLiNER2 sidecar. If set, the
 *                                interpreter uses the HTTP provider; if unset,
 *                                the bundled mock provider runs in fixture mode.
 *   HEARTH_OPENCLAW_URL          base URL of the OpenClaw external Gateway.
 *                                Loopback-only (asserted at construction).
 *                                If set AND HEARTH_GATEWAY_TOKEN is also set,
 *                                the interpreter's Bonsai provider routes through
 *                                OpenClaw. If unset (or invalid), no real
 *                                Bonsai provider is wired and the interpreter's
 *                                bonsai slot stays null (interpreter then only
 *                                succeeds via grammar + GLiNER2).
 *   HEARTH_GATEWAY_TOKEN         bearer token for the OpenClaw Gateway. Read
 *                                at startup; never printed in logs.
 *   HEARTH_BONSAI_DISABLED       "1" forces bonsai to null regardless of
 *                                OpenClaw env. Useful for fixture-mode runs
 *                                that need to assert the no-bonsai code path.
 */
import {
  SystemClock,
  InMemoryExecutionStore,
  type ExecutionStore,
} from '@hearth/executor';
import {
  HAConnectionPool,
  LiveHAAdapter,
  loadDefaultFixture,
} from '@hearth/ha-adapter';
import { RegistryOverlay } from '@hearth/registry';
import {
  OpenClawBonsaiProvider,
  OpenClawPermanentError,
  OpenClawPinError,
  OpenClawTransientError,
} from '@hearth/openclaw-adapter';
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

/**
 * Resolve which HA adapter to wire based on env. Returns the adapter
 * and a tagged mode so the rest of main() can log and guard.
 *
 * Mode rules:
 *   - HEARTH_FIXTURE_MODE unset or "1" -> fixture (default; safe).
 *   - HEARTH_FIXTURE_MODE "0":
 *     - HEARTH_HA_URL must be set, else fail closed.
 *     - HEARTH_HA_TOKEN must be set, else fail closed.
 *     - On success, instantiate LiveHAAdapter.
 */
async function resolveAdapter(): Promise<{
  adapter: import('@hearth/contracts').HomeAssistantAdapter;
  pool: import('@hearth/ha-adapter').HAConnectionPool;
  registry: RegistryOverlay;
  mode: 'fixture' | 'live';
  ha_url?: string;
}> {
  const fixture_mode = (process.env.HEARTH_FIXTURE_MODE ?? '1') !== '0';

  if (fixture_mode) {
    const fixture = loadDefaultFixture();
    const registry = new RegistryOverlay({
      devices: fixture.devices,
      rooms: fixture.rooms,
      entity_version: 1,
      scene_versions: {},
    });
    const pool = new HAConnectionPool(fixture);
    return { adapter: pool.getActive(), pool, registry, mode: 'fixture' };
  }

  // Live mode path; fail closed if any required env is missing.
  const ha_url = process.env.HEARTH_HA_URL ?? '';
  const ha_token = process.env.HEARTH_HA_TOKEN ?? '';
  if (!ha_url) {
    throw new Error('HEARTH_FIXTURE_MODE=0 but HEARTH_HA_URL is not set; refusing to start');
  }
  if (!ha_token) {
    throw new Error('HEARTH_FIXTURE_MODE=0 but HEARTH_HA_TOKEN is not set; refusing to start');
  }

  const live = new LiveHAAdapter({ base_url: ha_url, token: ha_token });
  // Probe HA before binding; fail closed if the token is bad or HA is
  // unreachable. The probe is a single /api/ call; no retries, no
  // backoff; the operator should see the error immediately.
  await live.probe();
  const [devices, rooms] = await Promise.all([live.listDevices(), live.listRooms()]);
  const registry = new RegistryOverlay({
    devices: devices as never,
    rooms: rooms as never,
    entity_version: 1,
    scene_versions: {},
  });
  // The pool still wires a fake adapter (so existing code paths that
  // ask for it keep working); the live one is set as active.
  const fixture = loadDefaultFixture();
  const pool = new HAConnectionPool(fixture, 'ha', live);
  return { adapter: pool.getActive(), pool, registry, mode: 'live', ha_url };
}

/**
 * Construct an OpenClawBonsaiProvider from environment if both
 * HEARTH_OPENCLAW_URL and HEARTH_GATEWAY_TOKEN are set. Otherwise
 * returns an empty spread so wireControl keeps bonsai=null.
 *
 * The base URL MUST resolve to loopback per assertLoopbackOnly. We
 * catch any thrown URL error and emit a startup warning so the
 * operator knows the env is malformed rather than silently dropping
 * to fixture.
 */
export function resolveBonsaiProvider(): { bonsai?: never } | { bonsai: OpenClawBonsaiProvider } {
  if (process.env.HEARTH_BONSAI_DISABLED === '1') return {};
  const url = process.env.HEARTH_OPENCLAW_URL ?? '';
  const token = process.env.HEARTH_GATEWAY_TOKEN ?? '';
  if (!url || !token) return {};
  try {
    const provider = new OpenClawBonsaiProvider({ base_url: url, token });
    // eslint-disable-next-line no-console
    console.log(`[hearth-control] bonsai provider wired: openclaw @ ${url}`);
    return { bonsai: provider };
  } catch (err) {
    // Loopback guard failed, or gateway URL is malformed. Log loud,
    // fall back to no bonsai provider (interpreter gets null).
    // eslint-disable-next-line no-console
    console.warn('[hearth-control] bonsai provider NOT wired:', (err as Error).message);
    return {};
  }
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
  const extract_url = process.env.HEARTH_EXTRACT_URL ?? '';

  // Resolve adapter (fixture or live). resolveAdapter() throws if
  // live mode is requested without the required env, which we let
  // propagate to the catch below so the operator sees a clean error.
  const resolved = await resolveAdapter();
  // eslint-disable-next-line no-console
  console.log(`[hearth-control] adapter mode: ${resolved.mode}${resolved.ha_url ? ` (${resolved.ha_url})` : ''}`);
  const { adapter, registry } = resolved;

  const store = await makeStore(sqlite_path);
  const clock = new SystemClock();

  const wired = await wireControl({
    registry,
    adapter,
    store,
    clock,
    session_secret,
    ...(extract_url ? { gliner2_http_url: extract_url } : {}),
    ...resolveBonsaiProvider(),
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

  // Check 6: Adapter mode. Fixture mode is the safe default; live mode
  // requires both HEARTH_HA_URL and HEARTH_HA_TOKEN to be configured.
  // In live mode, additionally probe HA's /api/ endpoint to confirm
  // it's reachable and the token is good. Probe failure -> FAIL.
  const fixture_mode = (process.env.HEARTH_FIXTURE_MODE ?? '1') !== '0';
  if (fixture_mode) {
    checks.push({ name: 'adapter-mode', status: 'PASS', detail: 'fixture (HEARTH_FIXTURE_MODE=1); live HA not required' });
  } else {
    const ha_url = process.env.HEARTH_HA_URL ?? '';
    const ha_token = process.env.HEARTH_HA_TOKEN ?? '';
    if (!ha_url || !ha_token) {
      checks.push({
        name: 'adapter-mode',
        status: 'FAIL',
        detail: 'HEARTH_FIXTURE_MODE=0 but HEARTH_HA_URL and HEARTH_HA_TOKEN must both be set',
      });
    } else {
      checks.push({
        name: 'adapter-mode',
        status: 'PASS',
        detail: `live (HEARTH_HA_URL=${ha_url})`,
      });
      // Item 8: live-resource probe.
      try {
        const res = await fetch(`${ha_url.replace(/\/$/, '')}/api/`, {
          headers: { Authorization: `Bearer ${ha_token}` },
        });
        if (!res.ok) {
          checks.push({
            name: 'ha-reachable',
            status: 'FAIL',
            detail: `${ha_url}/api/ returned ${res.status} (token bad or HA down)`,
          });
        } else {
          const body = await res.json() as { message?: string };
          if (body.message && body.message !== 'API running.' && !/running/i.test(body.message)) {
            checks.push({
              name: 'ha-reachable',
              status: 'FAIL',
              detail: `${ha_url}/api/ returned unexpected body: ${JSON.stringify(body).slice(0, 120)}`,
            });
          } else {
            checks.push({
              name: 'ha-reachable',
              status: 'PASS',
              detail: `${ha_url}/api/ responded`,
            });
          }
        }
      } catch (err) {
        checks.push({
          name: 'ha-reachable',
          status: 'FAIL',
          detail: `${ha_url} unreachable: ${(err as Error).message}`,
        });
      }
    }
  }

  // Check 7: OpenClaw adapter wiring (item 8 doctor check).
  // The OpenClaw URL is loopback-only. If set, probe /agent/turn with a
  // 401-style request to confirm the Gateway is alive (it should
  // return 401 or 400, never connection-refused). If unset, the
  // interpreter falls back to grammar+GLiNER2 only, which is OK.
  const openclaw_url = process.env.HEARTH_OPENCLAW_URL ?? '';
  const openclaw_token = process.env.HEARTH_GATEWAY_TOKEN ?? '';
  if (openclaw_url) {
    // Loopback guard first.
    let host_ok = false;
    try {
      const u = new URL(openclaw_url);
      host_ok = (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]');
    } catch {
      // fall through
    }
    if (!host_ok) {
      checks.push({
        name: 'openclaw-reachable',
        status: 'FAIL',
        detail: `${openclaw_url} is not loopback; Hearth refuses non-loopback OpenClaw`,
      });
    } else if (!openclaw_token) {
      checks.push({
        name: 'openclaw-reachable',
        status: 'FAIL',
        detail: `HEARTH_OPENCLAW_URL set but HEARTH_GATEWAY_TOKEN is empty`,
      });
    } else {
      try {
        // An OPTIONS or fake POST will tell us the gateway is alive.
        // We expect 401/400/404 from any real endpoint.
        const res = await fetch(`${openclaw_url.replace(/\/$/, '')}/agent/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openclaw_token}`,
          },
          body: JSON.stringify({ probe: true }),
        });
        if (res.status === 404) {
          checks.push({
            name: 'openclaw-reachable',
            status: 'WARN',
            detail: `${openclaw_url}/agent/turn returned 404; verify the Gateway version (expected 2026.9.6)`,
          });
        } else if (res.status >= 500) {
          checks.push({
            name: 'openclaw-reachable',
            status: 'FAIL',
            detail: `${openclaw_url}/agent/turn returned ${res.status}`,
          });
        } else {
          // 400/401/403 all mean: gateway is alive, accepts this URL.
          checks.push({
            name: 'openclaw-reachable',
            status: 'PASS',
            detail: `${openclaw_url}/agent/turn responded (${res.status}); token accepted`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'openclaw-reachable',
          status: 'FAIL',
          detail: `${openclaw_url} unreachable: ${(err as Error).message}`,
        });
      }
    }
  } else {
    checks.push({
      name: 'openclaw-reachable',
      status: 'WARN',
      detail: 'HEARTH_OPENCLAW_URL not set; bonsai provider disabled (grammar + GLiNER2 only)',
    });
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
