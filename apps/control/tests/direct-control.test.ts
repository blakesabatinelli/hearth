import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, createSession, csrfHeaders, type TestControl } from './fixtures.js';

let tc: TestControl;

beforeEach(async () => { tc = await buildTestControl(); });
afterEach(async () => { await tc.tearDown(); });

describe('executor-backed direct device controls', () => {
  it('runs a fixture light control through the executor with a server-resolved target', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((d) => d.load_type === 'light')!;
    const session = await createSession(tc.app, 'admin');
    const res = await tc.app.inject({
      method: 'POST',
      url: `/v1/devices/${encodeURIComponent(lamp.canonical_id)}/control`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { desired_values: { on: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('contract_id');
    expect(res.json()).toHaveProperty('receipt');
    expect((await tc.adapter.getState(lamp.canonical_id)).values.on).toBe(true);
  });

  it('runs a direct fixture command with GLiNER2 and Bonsai unavailable', async () => {
    let gliner_calls = 0;
    let bonsai_calls = 0;
    await tc.tearDown();
    tc = await buildTestControl({
      gliner2: {
        async extract() { gliner_calls++; throw new Error('GLiNER2 is stopped'); },
        async health() { return { ready: false, checkpoint_id: 'stopped', latency_ms_p50: null }; },
      },
      bonsai: {
        async propose() { bonsai_calls++; throw new Error('Bonsai is stopped'); },
        validateProposal() { throw new Error('Bonsai is stopped'); },
      },
    });
    const lamp = tc.hearth_registry.snapshot().devices.find((d) => d.friendly_name === 'Living Room Lamp')!;
    const session = await createSession(tc.app, 'admin');
    const interpreted = await tc.app.inject({
      method: 'POST', url: '/v1/interpret',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { utterance: 'turn on the living room lamp' },
    });
    const decision = (interpreted.json() as { request_id: string; decision: { outcome: string; proposal?: unknown; proposal_receipt?: string } }).decision;
    expect(interpreted.statusCode).toBe(200);
    expect(decision.outcome).toBe('ready_for_contract');
    const outer = interpreted.json() as { request_id: string };
    const executed = await tc.app.inject({
      method: 'POST', url: '/v1/contracts',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: {
        request_id: outer.request_id,
        proposal: decision.proposal,
        proposal_receipt: decision.proposal_receipt,
      },
    });
    expect(executed.statusCode).toBe(200);
    expect((await tc.adapter.getState(lamp.canonical_id)).values.on).toBe(true);
    expect(gliner_calls).toBe(0);
    expect(bonsai_calls).toBe(0);
  });

  it('derives authority from the session and rejects extra client authority fields', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((d) => d.load_type === 'light')!;
    const session = await createSession(tc.app, 'member');
    const res = await tc.app.inject({
      method: 'POST',
      url: `/v1/devices/${encodeURIComponent(lamp.canonical_id)}/control`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { desired_values: { on: true }, role: 'admin', actor_id: 'forged' },
    });

    expect(res.statusCode).toBe(400);
    expect((await tc.adapter.getState(lamp.canonical_id)).values.on).toBe(false);
  });

  it('rejects unclassified switches from the touch-control route', async () => {
    const mystery = tc.hearth_registry.snapshot().devices.find((d) => d.load_type === 'unknown-switch')!;
    const session = await createSession(tc.app, 'admin');
    const res = await tc.app.inject({
      method: 'POST',
      url: `/v1/devices/${encodeURIComponent(mystery.canonical_id)}/control`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { desired_values: { on: true } },
    });

    expect(res.statusCode).toBe(422);
    expect((await tc.adapter.getState(mystery.canonical_id)).values.on).toBe(false);
  });

  it('keeps a classified light read-only when the live HA allowlist excludes its route', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((d) => d.load_type === 'light')!;
    await tc.tearDown();
    tc = await buildTestControl({ live_ha_actuation_allowlist: new Set() });
    const session = await createSession(tc.app, 'admin');
    const res = await tc.app.inject({
      method: 'POST',
      url: `/v1/devices/${encodeURIComponent(lamp.canonical_id)}/control`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { desired_values: { on: true } },
    });

    expect(res.statusCode).toBe(403);
    expect((await tc.adapter.getState(lamp.canonical_id)).values.on).toBe(false);
  });

  it('requires a valid session and CSRF token', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((d) => d.load_type === 'light')!;
    const url = `/v1/devices/${encodeURIComponent(lamp.canonical_id)}/control`;
    const no_session = await tc.app.inject({ method: 'POST', url, payload: { desired_values: { on: true } } });
    expect(no_session.statusCode).toBe(401);

    const session = await createSession(tc.app, 'admin');
    const no_csrf = await tc.app.inject({
      method: 'POST', url,
      headers: { cookie: session.cookie },
      payload: { desired_values: { on: true } },
    });
    expect(no_csrf.statusCode).toBe(403);
    expect((await tc.adapter.getState(lamp.canonical_id)).values.on).toBe(false);
  });

  it('preserves an "everything except" exclusion through resolution and execution', async () => {
    const devices = tc.hearth_registry.snapshot().devices;
    const kitchen = devices.find((device) => device.friendly_name === 'Kitchen Lights')!;
    const expectedTargets = devices.filter((device) => device.load_type === 'light' && device.canonical_id !== kitchen.canonical_id);
    const session = await createSession(tc.app, 'admin');
    const interpreted = await tc.app.inject({
      method: 'POST', url: '/v1/interpret',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { utterance: 'turn off everything except the kitchen lights' },
    });
    expect(interpreted.statusCode).toBe(200);
    const interpretation = interpreted.json() as {
      request_id: string;
      decision: { outcome: string; proposal?: unknown; proposal_receipt?: string };
    };
    expect(interpretation.decision.outcome).toBe('ready_for_contract');
    expect(interpretation.decision.proposal).toMatchObject({ exclusions: ['Kitchen Lights'] });

    const executed = await tc.app.inject({
      method: 'POST', url: '/v1/contracts',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: {
        request_id: interpretation.request_id,
        proposal: interpretation.decision.proposal,
        proposal_receipt: interpretation.decision.proposal_receipt,
      },
    });
    expect(executed.statusCode, executed.body).toBe(200);
    const receipt = (executed.json() as { receipt: { per_target: Record<string, unknown> } }).receipt;
    expect(Object.keys(receipt.per_target).sort()).toEqual(expectedTargets.map((device) => device.canonical_id).sort());
    expect(receipt.per_target).not.toHaveProperty(kitchen.canonical_id);
  });
});
