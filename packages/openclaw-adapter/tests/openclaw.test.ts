/**
 * OpenClawBonsaiProvider tests.
 *
 * The provider is an HTTP client around the OpenClaw external
 * Gateway. These tests mock fetch so the unit suite runs offline.
 *
 * Coverage:
 *   - URL guard (loopback only, protocol check)
 *   - Provider propose() happy path -> IntentProposal
 *   - validateProposal strict rejection paths
 *   - Network error -> OpenClawTransientError
 *   - 5xx -> transient, retried once
 *   - 4xx -> permanent
 *   - Pin drift -> OpenClawPinError
 *   - One-retry cap (no infinite retries)
 *   - Schema version drift
 */

import { describe, it, expect } from 'vitest';
import {
  OpenClawBonsaiProvider,
  OpenClawPermanentError,
  OpenClawPinError,
  OpenClawTransientError,
  ProposalValidationError,
  assertLoopbackOnly,
  buildSystemPrompt,
  buildUserPrompt,
  validateProposalRaw,
} from '../src/index.js';
import type {
  ProposalContext,
} from '@hearth/contracts';

const CONTEXT: ProposalContext = {
  known_devices: [
    {
      canonical_id: 'ha:light.living_room_lamp' as never,
      friendly_name: 'Living Room Lamp',
      aliases: ['main lights', 'the lamp'],
      room_name: 'Living Room',
    },
  ],
  known_scenes: [],
  recent_fresh_state: [],
};

function makeValidProposal(): Record<string, unknown> {
  return {
    request_id: 'req-1',
    intent_family: 'set-state',
    target_phrases: ['Living Room Lamp'],
    exclusions: [],
    desired_values: { on: true },
    temporal: null,
    unresolved_fields: [],
    confidence: 0.92,
    provenance: {
      source: 'bonsai',
      adapter_id: 'openclaw',
      schema_version: '0.0.1',
    },
  };
}

function makeMockFetch(handler: (req: { url: string; body: unknown; headers: Record<string, string> }) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    let body: unknown = null;
    if (init?.body) {
      body = JSON.parse(init.body as string);
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) {
          if (Array.isArray(pair) && pair.length >= 1) {
            const k = pair[0] as string;
            const v = pair[1] as string;
            headers[k] = v;
          }
        }
      } else {
        Object.assign(headers, init.headers as Record<string, string>);
      }
    }
    return handler({ url, body, headers });
  }) as typeof fetch;
}

describe('assertLoopbackOnly', () => {
  it('accepts loopback URLs', () => {
    expect(() => assertLoopbackOnly('http://127.0.0.1:8443')).not.toThrow();
    expect(() => assertLoopbackOnly('http://localhost:8443')).not.toThrow();
    expect(() => assertLoopbackOnly('http://[::1]:8443')).not.toThrow();
    expect(() => assertLoopbackOnly('https://127.0.0.1:8443')).not.toThrow();
  });
  it('rejects non-loopback hosts', () => {
    expect(() => assertLoopbackOnly('http://test-1.example.com:8443')).toThrow(/loopback/i);
    expect(() => assertLoopbackOnly('http://test-2.example.com:8443')).toThrow(/loopback/i);
    expect(() => assertLoopbackOnly('http://test-3.example.com:8443')).toThrow(/loopback/i);
    expect(() => assertLoopbackOnly('http://gateway.example.com:8443')).toThrow(/loopback/i);
    expect(() => assertLoopbackOnly('http://0.0.0.0:8443')).toThrow(/loopback/i);
  });
  it('rejects non-http(s) protocols', () => {
    expect(() => assertLoopbackOnly('file://127.0.0.1/etc/passwd')).toThrow(/http\(s\)/i);
    expect(() => assertLoopbackOnly('ws://127.0.0.1:8443')).toThrow(/http\(s\)/i);
  });
  it('rejects malformed URLs', () => {
    expect(() => assertLoopbackOnly('not-a-url')).toThrow(/invalid/i);
  });
});

describe('OpenClawBonsaiProvider construction', () => {
  it('throws on non-loopback URL', () => {
    expect(() => new OpenClawBonsaiProvider({ base_url: 'http://test-1.example.com:8443', token: 't' })).toThrow();
  });

  it('strips trailing slash from base_url', () => {
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443/', token: 't' });
    expect(p.base_url).toBe('http://127.0.0.1:8443');
  });

  it('uses default adapter_id and HEARTH_OPENCLAW_PIN', () => {
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't' });
    expect(p.adapter_id).toBe('openclaw');
    expect(p.expected_pin).toBe('2026.9.6');
  });
});

describe('OpenClawBonsaiProvider propose()', () => {
  it('sends bearer token and schema, parses response into IntentProposal', async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | null = null;
    const f = makeMockFetch((req) => {
      captured = req;
      return new Response(JSON.stringify({ proposal: makeValidProposal(), openclaw_pin: '2026.9.6' }), { status: 200 });
    });
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 'tok-X', fetch_impl: f });
    const proposal = await p.propose({ request_id: 'req-1', utterance: 'turn on the lamp', context: CONTEXT });
    expect(proposal.intent_family).toBe('set-state');
    expect(proposal.target_phrases).toEqual(['Living Room Lamp']);
    expect(proposal.desired_values).toEqual({ on: true });
    expect(proposal.provenance.source).toBe('bonsai');
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('http://127.0.0.1:8443/agent/turn');
    expect(captured!.headers['Authorization']).toBe('Bearer tok-X');
    expect(captured!.headers['X-OpenClaw-Pin']).toBe('2026.9.6');
    const body = captured!.body as Record<string, unknown>;
    expect(body['tool']).toBe('bonsai_thinking');
    expect(body['schema_version']).toBe('0.0.1');
  });

  it('retries once on 5xx, fails on second 5xx', async () => {
    let calls = 0;
    const f = makeMockFetch(() => {
      calls += 1;
      return new Response('boom', { status: 503 });
    });
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(OpenClawTransientError);
    expect(calls).toBe(2);
  });

  it('succeeds after one 5xx retry', async () => {
    let calls = 0;
    const f = makeMockFetch(() => {
      calls += 1;
      if (calls === 1) return new Response('upstream-fail', { status: 502 });
      return new Response(JSON.stringify({ proposal: makeValidProposal(), openclaw_pin: '2026.9.6' }), { status: 200 });
    });
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    const proposal = await p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT });
    expect(proposal.intent_family).toBe('set-state');
    expect(calls).toBe(2);
  });

  it('retries once on network error, fails on second', async () => {
    let calls = 0;
    const f = makeMockFetch(() => {
      calls += 1;
      throw new TypeError('ECONNRESET');
    });
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(OpenClawTransientError);
    expect(calls).toBe(2);
  });

  it('does NOT retry on 4xx', async () => {
    let calls = 0;
    const f = makeMockFetch(() => {
      calls += 1;
      return new Response('nope', { status: 400 });
    });
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(OpenClawPermanentError);
    expect(calls).toBe(1);
  });

  it('throws OpenClawPinError on pin drift', async () => {
    const f = makeMockFetch(() => new Response(JSON.stringify({ proposal: makeValidProposal(), openclaw_pin: '9999.0.0' }), { status: 200 }));
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(OpenClawPinError);
  });

  it('does NOT silently coerce invalid proposals', async () => {
    const invalid: Record<string, unknown> = makeValidProposal();
    invalid['intent_family'] = 'teleport-device';  // not in enum
    const f = makeMockFetch(() => new Response(JSON.stringify({ proposal: invalid, openclaw_pin: '2026.9.6' }), { status: 200 }));
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(ProposalValidationError);
  });

  it('rejects schema_version drift', async () => {
    const invalid: Record<string, unknown> = makeValidProposal();
    const prov = invalid['provenance'] as Record<string, unknown>;
    prov['schema_version'] = '0.0.2';
    const f = makeMockFetch(() => new Response(JSON.stringify({ proposal: invalid, openclaw_pin: '2026.9.6' }), { status: 200 }));
    const p = new OpenClawBonsaiProvider({ base_url: 'http://127.0.0.1:8443', token: 't', fetch_impl: f });
    await expect(p.propose({ request_id: 'r', utterance: 'x', context: CONTEXT })).rejects.toBeInstanceOf(ProposalValidationError);
  });
});

describe('validateProposalRaw', () => {
  it('accepts a valid proposal', () => {
    const proposal = validateProposalRaw(makeValidProposal());
    expect(proposal.intent_family).toBe('set-state');
  });

  it('rejects non-object input', () => {
    expect(() => validateProposalRaw(null)).toThrow(ProposalValidationError);
    expect(() => validateProposalRaw(42)).toThrow(ProposalValidationError);
    expect(() => validateProposalRaw('string')).toThrow(ProposalValidationError);
  });

  it('rejects unknown intent_family', () => {
    const invalid = makeValidProposal();
    invalid['intent_family'] = 'nope';
    expect(() => validateProposalRaw(invalid)).toThrow(/intent_family/);
  });

  it('rejects target_phrases of wrong type', () => {
    const invalid = makeValidProposal();
    invalid['target_phrases'] = [42];
    expect(() => validateProposalRaw(invalid)).toThrow(/target_phrases/);
  });

  it('rejects confidence out of [0,1]', () => {
    const invalid = makeValidProposal();
    invalid['confidence'] = 1.5;
    expect(() => validateProposalRaw(invalid)).toThrow(/confidence/);
  });

  it('rejects provenance.source != bonsai', () => {
    const invalid = makeValidProposal();
    const prov = invalid['provenance'] as Record<string, unknown>;
    prov['source'] = 'grammar';
    expect(() => validateProposalRaw(invalid)).toThrow(/provenance/);
  });

  it('validates temporal.until requires iso + restore_behavior', () => {
    const invalid = makeValidProposal();
    invalid['temporal'] = { kind: 'until' };  // missing iso + restore_behavior
    expect(() => validateProposalRaw(invalid)).toThrow(/temporal/);
  });

  it('validates temporal.for-duration requires numeric seconds', () => {
    const invalid = makeValidProposal();
    invalid['temporal'] = { kind: 'for-duration', restore_behavior: 'restore-previous', seconds: 'ten' };
    expect(() => validateProposalRaw(invalid)).toThrow(/seconds/);
  });

  it('validates desired_values types', () => {
    const invalid = makeValidProposal();
    invalid['desired_values'] = { on: { nested: 'no' } };
    expect(() => validateProposalRaw(invalid)).toThrow(/desired_values/);
  });
});

describe('prompts', () => {
  it('system prompt includes schema version', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Schema version: 0.0.1');
    expect(prompt.toLowerCase()).toContain('bonsai');
  });

  it('user prompt renders friendly names but never entity_ids', () => {
    const prompt = buildUserPrompt({ request_id: 'r1', utterance: 'turn on', context: CONTEXT });
    expect(prompt).toContain('Living Room Lamp');
    expect(prompt).toContain('Living Room');
    // No HA entity_id surfaces in the prompt
    expect(prompt).not.toContain('ha:light.living_room_lamp');
    // No token/auth info leaks
    expect(prompt).not.toContain('Bearer');
    expect(prompt).not.toContain('token');
  });
});
