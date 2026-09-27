/** Stage 0 Gateway RPC adapter integration tests. */

import { describe, it, expect } from 'vitest';
import { OpenClawBonsaiProvider } from '@hearth/openclaw-adapter';

const VALID_PROPOSAL = {
  request_id: 'rt-1',
  intent_family: 'set-state',
  target_phrases: ['Living Room Lamp'],
  exclusions: [],
  desired_values: { on: true },
  temporal: null,
  unresolved_fields: [],
  confidence: 0.95,
  provenance: { source: 'bonsai', adapter_id: 'openclaw-stage0', schema_version: '0.0.1' },
};

function fakeGateway(proposal: unknown, optionsSeen?: Record<string, unknown>) {
  return (options: Record<string, unknown>) => {
    Object.assign(optionsSeen ?? {}, options);
    const onEvent = options.onEvent as (event: unknown) => void;
    return {
      start() { (options.onHelloOk as (hello: unknown) => void)({ server: { version: '2026.9.6' } }); },
      async stopAndWait() {},
      async request(method: string, params?: unknown) {
        if (method === 'agent') {
          const request = params as Record<string, unknown>;
          const message = String(request.message);
          expect(message).toContain('You never propose an action');
          const id = String(request.idempotencyKey);
          const raw = typeof proposal === 'function' ? (proposal as (id: string) => unknown)(id) : proposal;
          onEvent({ event: 'agent', payload: { runId: 'run-stage0', stream: 'assistant', data: { text: JSON.stringify(raw) } } });
          return { accepted: true, runId: 'run-stage0' };
        }
        if (method === 'agent.wait') return { status: 'ok' };
        throw new Error(`unexpected Gateway RPC: ${method}`);
      },
    };
  };
}

describe('Stage 0 round-trip: OpenClaw Gateway adapter to Hearth proposal', () => {
  it('validates the Gateway streamed response and pins the handshake', async () => {
    const seen: Record<string, unknown> = {};
    const provider = new OpenClawBonsaiProvider({
      base_url: 'http://127.0.0.1:18789', token: 'tok', client_factory: fakeGateway(VALID_PROPOSAL, seen),
    });
    const proposal = await provider.propose({
      request_id: 'rt-1',
      utterance: 'turn on the living room lamp',
      context: {
        known_devices: [{ canonical_id: 'ha:light.living_room_lamp' as never, friendly_name: 'Living Room Lamp', aliases: ['the lamp'], room_name: 'Living Room' }],
        known_scenes: [], recent_fresh_state: [],
      },
    });
    expect(proposal.intent_family).toBe('set-state');
    expect(proposal.target_phrases[0]).toBe('Living Room Lamp');
    expect(proposal.desired_values).toEqual({ on: true });
    expect(proposal.confidence).toBe(0.95);
    expect(seen).toMatchObject({ url: 'ws://127.0.0.1:18789', scopes: ['operator.write'], minProtocol: 4, maxProtocol: 4 });
  });

  it('uses the request ID as an idempotency key and does not replay accepted runs', async () => {
    let agentCalls = 0;
    const factory = (options: Record<string, unknown>) => {
      const onEvent = options.onEvent as (event: unknown) => void;
      return {
        start() { (options.onHelloOk as (hello: unknown) => void)({ server: { version: '2026.9.6' } }); },
        async stopAndWait() {},
        async request(method: string, params?: unknown) {
          if (method === 'agent') {
            agentCalls += 1;
            expect(params).toMatchObject({ idempotencyKey: 'rt-2' });
            return { accepted: true, runId: 'run-2' };
          }
          onEvent({ event: 'agent', payload: { runId: 'run-2', stream: 'assistant', data: { text: JSON.stringify({ ...VALID_PROPOSAL, request_id: 'rt-2' }) } } });
          throw new Error('run wait failed after acceptance');
        },
      };
    };
    const provider = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 'tok', client_factory: factory });
    await expect(provider.propose({ request_id: 'rt-2', utterance: 'turn off the lamp', context: { known_devices: [], known_scenes: [], recent_fresh_state: [] } })).rejects.toThrow();
    expect(agentCalls).toBe(1);
  });

  it('does not silently repair invalid proposals or accept a mismatched request ID', async () => {
    const invalid = { ...VALID_PROPOSAL, request_id: 'rt-3', intent_family: 'teleport' };
    const provider = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 'tok', client_factory: fakeGateway(invalid) });
    await expect(provider.propose({ request_id: 'rt-3', utterance: 'turn on the lamp', context: { known_devices: [], known_scenes: [], recent_fresh_state: [] } })).rejects.toThrow();

    const mismatched = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 'tok', client_factory: fakeGateway(VALID_PROPOSAL) });
    await expect(mismatched.propose({ request_id: 'rt-4', utterance: 'turn on the lamp', context: { known_devices: [], known_scenes: [], recent_fresh_state: [] } })).rejects.toThrow(/request_id/);
  });
});
