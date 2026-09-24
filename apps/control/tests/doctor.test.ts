/**
 * Doctor subcommand tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, type TestControl } from './fixtures.js';

let tc: TestControl;

beforeEach(async () => {
  tc = await buildTestControl();
});

afterEach(async () => {
  await tc.tearDown();
});

describe('doctor subcommand via HTTP', () => {
  it('GET /healthz returns ok', async () => {
    const res = await tc.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports ready with device count', async () => {
    const res = await tc.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; device_count: number };
    expect(body.status).toBe('ready');
    expect(body.device_count).toBeGreaterThan(0);
  });
});

describe('doctor() programmatic checks', () => {
  // The doctor() function in main.ts runs five checks and prints PASS/WARN/FAIL.
  // We invoke it by importing the module (which does NOT bind a port: doctor
  // is exported as a named function and the CLI bootstrap is wrapped in
  // main(), which only runs when invoked via the binary entry point).
  it('runs all five checks without crashing', async () => {
    process.env.HEARTH_SESSION_SECRET = 'a'.repeat(40);
    delete process.env.HEARTH_EXTRACT_URL;
    const { doctor } = await import('../src/main.js');
    const captured: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    try {
      await doctor();
    } finally {
      console.log = orig;
    }
    expect(captured.some((l) => l.includes('Summary'))).toBe(true);
    const joined = captured.join('\n');
    expect(joined).toMatch(/node-runtime|sqlite|session-secret|gliner2-sidecar/);
  });

  it('returns fail > 0 when HEARTH_SESSION_SECRET is the dev default', async () => {
    process.env.HEARTH_SESSION_SECRET = 'dev-secret-change-me';
    const { doctor } = await import('../src/main.js');
    const captured: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    try {
      const result = await doctor();
      expect(result.fail).toBeGreaterThan(0);
      expect(result.pass + result.warn + result.fail).toBeGreaterThan(0);
    } finally {
      console.log = orig;
    }
  });
});