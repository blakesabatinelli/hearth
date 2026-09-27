import { describe, it, expect } from 'vitest';
import {
  OpenClawBonsaiProvider,
  OpenClawTransientError,
  ProposalValidationError,
  assertLoopbackOnly,
  buildSystemPrompt,
  buildUserPrompt,
} from '../src/index.js';
import type { ProposalContext } from '@hearth/contracts';

const CONTEXT: ProposalContext = {
  known_devices: [{ canonical_id: 'ha:light.living_room_lamp' as never, friendly_name: 'Living Room Lamp', aliases: ['main lights'], room_name: 'Living Room' }],
  known_scenes: [],
  recent_fresh_state: [],
};

function makeProposal(request_id = 'req-1'): Record<string, unknown> {
  return {
    request_id,
    intent_family: 'set-state',
    target_phrases: ['Living Room Lamp'],
    exclusions: [],
    desired_values: { on: true },
    temporal: null,
    unresolved_fields: [],
    confidence: 0.92,
    provenance: { source: 'bonsai', adapter_id: 'openclaw', schema_version: '0.0.1' },
  };
}

function makeClientFactory(proposal: unknown = makeProposal(), optionsSeen?: Record<string, unknown>) {
  return (options: Record<string, unknown>) => {
    Object.assign(optionsSeen ?? {}, options);
    const onEvent = options.onEvent as (event: unknown) => void;
    return {
      start() { (options.onHelloOk as () => void)(); },
      async stopAndWait() {},
      async request(method: string, params?: unknown) {
        if (method === 'agent') {
          expect(params).toMatchObject({ idempotencyKey: 'req-1' });
          const request = params as Record<string, unknown>;
          expect(request).toMatchObject({ thinking: 'off', promptMode: 'none', modelRun: true, disableMessageTool: true, timeout: 300 });
          expect(request.message).toContain('Use these keys: request_id, intent_family');
          expect(request.message).toContain('Schema version: 0.0.1');
          expect(request.message).toContain('User utterance: turn on the lamp');
          onEvent({ event: 'agent', payload: { runId: 'run-1', stream: 'assistant', data: { text: JSON.stringify(proposal) } } });
          return { accepted: true, runId: 'run-1' };
        }
        if (method === 'agent.wait') return { status: 'ok' };
        throw new Error(`unexpected method ${method}`);
      },
    };
  };
}

describe('assertLoopbackOnly', () => {
  it('accepts loopback URLs and rejects remote URLs', () => {
    expect(() => assertLoopbackOnly('http://127.0.0.1:18789')).not.toThrow();
    expect(() => assertLoopbackOnly('http://localhost:18789')).not.toThrow();
    expect(() => assertLoopbackOnly('https://[::1]:18789')).not.toThrow();
    expect(() => assertLoopbackOnly('http://gateway.example.com:18789')).toThrow(/loopback/i);
  });
});

describe('OpenClawBonsaiProvider', () => {
  it('uses the pinned Gateway WebSocket and returns a validated Bonsai proposal', async () => {
    const options: Record<string, unknown> = {};
    const provider = new OpenClawBonsaiProvider({
      base_url: 'http://127.0.0.1:18789/', token: 'secret-for-test', client_factory: makeClientFactory(makeProposal(), options),
    });
    const result = await provider.propose({ request_id: 'req-1', utterance: 'turn on the lamp', context: CONTEXT });
    expect(result.intent_family).toBe('set-state');
    expect(options).toMatchObject({
      url: 'ws://127.0.0.1:18789', token: 'secret-for-test', role: 'operator', scopes: ['operator.write'],
      minProtocol: 4, maxProtocol: 4, mode: 'backend',
    });
  });

  it('fails closed on malformed JSON and unsupported proposals', async () => {
    const invalid = new OpenClawBonsaiProvider({
      base_url: 'http://127.0.0.1:18789', token: 't', client_factory: makeClientFactory('not-json'),
    });
    await expect(invalid.propose({ request_id: 'req-1', utterance: 'turn on the lamp', context: CONTEXT })).rejects.toBeInstanceOf(ProposalValidationError);

    const unsupported = makeProposal();
    unsupported.intent_family = 'teleport-device';
    const invalidProposal = new OpenClawBonsaiProvider({
      base_url: 'http://127.0.0.1:18789', token: 't', client_factory: makeClientFactory(unsupported),
    });
    await expect(invalidProposal.propose({ request_id: 'req-1', utterance: 'turn on the lamp', context: CONTEXT })).rejects.toBeInstanceOf(ProposalValidationError);
  });

  it('rejects an agent run that fails to complete', async () => {
    const client_factory = (options: Record<string, unknown>) => ({
      start() { (options.onHelloOk as () => void)(); },
      async stopAndWait() {},
      async request(method: string) {
        if (method === 'agent') return { accepted: true, runId: 'run-1' };
        return { status: 'error', error: 'model failed' };
      },
    });
    const provider = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 't', client_factory });
    await expect(provider.turn({ request_id: 'req-1', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(Error);
  });

  it('continues waiting after an observation timeout instead of abandoning the accepted run', async () => {
    let waits = 0;
    const client_factory = (options: Record<string, unknown>) => ({
      start() { (options.onHelloOk as () => void)(); },
      async stopAndWait() {},
      async request(method: string) {
        if (method === 'agent') return { runId: 'run-1' };
        if (method === 'agent.wait') {
          waits++;
          return waits === 1 ? { status: 'timeout' } : { status: 'ok' };
        }
        throw new Error(`unexpected method ${method}`);
      },
    });
    const provider = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 't', client_factory });
    await expect(provider.turn({ request_id: 'req-1', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(ProposalValidationError);
    expect(waits).toBe(2);
  });

  it('aborts the exact Gateway run when Hearth inference deadline expires', async () => {
    const methods: string[] = [];
    const client_factory = (options: Record<string, unknown>) => ({
      start() { (options.onHelloOk as () => void)(); },
      async stopAndWait() {},
      async request(method: string) {
        methods.push(method);
        if (method === 'agent') return { runId: 'run-expired' };
        if (method === 'agent.wait') return { status: 'timeout' };
        if (method === 'sessions.abort') return { status: 'aborted' };
        throw new Error(`unexpected method ${method}`);
      },
    });
    const provider = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:18789', token: 't', timeout_ms: 1, client_factory });
    await expect(provider.turn({ request_id: 'req-1', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(OpenClawTransientError);
    expect(methods).toContain('sessions.abort');
  });
});

describe('prompt builders', () => {
  it('keeps the model prompt interpretation-only and friendly-name based', () => {
    expect(buildSystemPrompt()).toContain('exactly one JSON object');
    const prompt = buildUserPrompt({ request_id: 'r', utterance: 'x', context: CONTEXT });
    expect(prompt).toContain('Living Room Lamp');
    expect(prompt).not.toContain('ha:light.living_room_lamp');
  });
});
