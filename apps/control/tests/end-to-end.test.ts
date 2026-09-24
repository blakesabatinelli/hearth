/**
 * End-to-end: interpret -> contract -> receipt through the HTTP surface.
 *
 * Covers AC-12 (full HTTP loop), AC-15 (server-derived contract fields),
 * AC-16 (idempotency 409 through HTTP), AC-17 (receipt outcome).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, createSession, csrfHeaders, type TestControl } from './fixtures.js';

let tc: TestControl;

beforeEach(async () => {
  tc = await buildTestControl();
});

afterEach(async () => {
  await tc.tearDown();
});

const lampProposal = {
  request_id: 'req-lamp-1',
  intent_family: 'set-state',
  target_phrases: ['living room lamp'],
  exclusions: [],
  desired_values: { on: true },
  temporal: null,
  unresolved_fields: [],
  confidence: 1.0,
  provenance: { source: 'grammar' as const, matched_rule: 'turn-on' },
};

describe('AC-12 end-to-end HTTP loop', () => {
  it('interpret -> contracts -> receipt for a simple command', async () => {
    const sess = await createSession(tc.app);

    // Interpret
    const interpret_res = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { utterance: 'turn on the living room lamp' },
    });
    expect(interpret_res.statusCode).toBe(200);
    const interpret_body = interpret_res.json() as {
      request_id: string;
      decision: { outcome: string; proposal?: { intent_family: string } };
    };
    expect(interpret_body.decision.outcome).toBe('ready_for_contract');
    expect(interpret_body.decision.proposal?.intent_family).toBe('set-state');

    // Submit contract
    const contract_res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: lampProposal, request_id: 'req-lamp-1' },
    });
    expect(contract_res.statusCode).toBe(200);
    const contract_body = contract_res.json() as {
      contract_id: string;
      receipt: { receipt_id: string; aggregate: string };
    };
    expect(contract_body.contract_id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(typeof contract_body.receipt.receipt_id).toBe('string');
  });

  it('GET /v1/devices returns the registry devices + rooms', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { cookie: sess.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      devices: ReadonlyArray<{ canonical_id: string; friendly_name: string }>;
      rooms: ReadonlyArray<{ room_id: string }>;
      actor: { role: string };
    };
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.rooms.length).toBeGreaterThan(0);
    expect(body.actor.role).toBe('admin');
  });

  it('GET /v1/devices/:id/state returns the device state', async () => {
    const sess = await createSession(tc.app);
    // First get a device id
    const dev_res = await tc.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { cookie: sess.cookie },
    });
    const dev_body = dev_res.json() as {
      devices: ReadonlyArray<{ canonical_id: string }>;
    };
    const lamp_id = dev_body.devices[0]!.canonical_id;
    const state_res = await tc.app.inject({
      method: 'GET',
      url: `/v1/devices/${encodeURIComponent(lamp_id)}/state`,
      headers: { cookie: sess.cookie },
    });
    expect(state_res.statusCode).toBe(200);
    const state_body = state_res.json() as { state: { canonical_id: string } };
    expect(state_body.state.canonical_id).toBe(lamp_id);
  });

  it('GET /v1/receipts/:id returns receipts for a contract', async () => {
    const sess = await createSession(tc.app);
    const submit = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: lampProposal, request_id: 'req-receipt-1' },
    });
    expect(submit.statusCode).toBe(200);
    const { contract_id } = submit.json() as { contract_id: string };
    const lookup = await tc.app.inject({
      method: 'GET',
      url: `/v1/receipts/${encodeURIComponent(contract_id)}`,
      headers: { cookie: sess.cookie },
    });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json() as { receipts: ReadonlyArray<unknown> };
    expect(body.receipts.length).toBeGreaterThan(0);
  });
});

describe('AC-16 idempotency through HTTP', () => {
  it('same request_id + same payload returns the prior receipt', async () => {
    const sess = await createSession(tc.app);
    const first = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: lampProposal, request_id: 'req-idem-1' },
    });
    expect(first.statusCode).toBe(200);
    const first_body = first.json() as { receipt: { receipt_id: string } };

    const second = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: lampProposal, request_id: 'req-idem-1' },
    });
    expect(second.statusCode).toBe(200);
    const second_body = second.json() as { receipt: { receipt_id: string } };
    expect(second_body.receipt.receipt_id).toBe(first_body.receipt.receipt_id);
  });

  it('same request_id + different payload returns 409', async () => {
    const sess = await createSession(tc.app);
    const first = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: lampProposal, request_id: 'req-conflict-1' },
    });
    expect(first.statusCode).toBe(200);

    const conflicting = {
      ...lampProposal,
      request_id: 'req-conflict-1',
      desired_values: { on: false }, // different payload!
    };
    const second = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { proposal: conflicting, request_id: 'req-conflict-1' },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_conflict');
  });
});

describe('Error mapping through HTTP', () => {
  it('ambiguous target phrase returns 409 stale_context', async () => {
    const sess = await createSession(tc.app);
    // 'bedroom' resolves to two devices (overhead + fan) -> ambiguous
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: {
        proposal: {
          request_id: 'req-bad-1',
          intent_family: 'set-state',
          target_phrases: ['bedroom'],
          exclusions: [],
          desired_values: { on: true },
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'turn-on' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('stale_context');
  });

  it('unknown target phrase returns 409 stale_context', async () => {
    const sess = await createSession(tc.app);
    // 'xyzzy_nonsense_qqq' should not match anything in the fixture
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: {
        proposal: {
          request_id: 'req-unknown-1',
          intent_family: 'set-state',
          target_phrases: ['xyzzy_nonsense_qqq'],
          exclusions: [],
          desired_values: { on: true },
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'turn-on' },
        },
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('stale_context');
  });
});