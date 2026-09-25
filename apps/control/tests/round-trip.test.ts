/**
 * Stage 0 round-trip integration test (plan section 13, item 9).
 *
 * The chain that defines Hearth:
 *
 *   grammar/interpreter
 *      -> GLiNER2 (HTTP sidecar)
 *      -> Bonsai (OpenClaw adapter)
 *      -> Hearth registry resolves target_phrases
 *      -> contract builder constructs dispatch
 *      -> executor dispatches via adapter
 *
 * This suite covers the gates that REQUIRE the OpenClaw adapter to be
 * live: when a request can neither satisfy the grammar nor finish
 * extraction, the interpreter falls back to Bonsai. We use an
 * in-process HTTP server that pretends to be OpenClaw's
 * `/agent/turn` and returns a valid Bonsai proposal.
 */

import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
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

async function withFakeOpenClaw(
  handler: (req: { body: string; call_count: { n: number } }) => { status: number; body?: unknown },
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const call_count = { n: 0 };
  const server: Server = createServer((req, res) => {
    if (req.url !== '/agent/turn' || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      call_count.n += 1;
      const r = handler({ body, call_count });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe('Stage 0 round-trip: OpenClaw adapter to Hearth interpreter', () => {
  it('propose() returns a valid IntentProposal from a loopback OpenClaw instance', async () => {
    await withFakeOpenClaw(
      ({ body }) => {
        const parsed = JSON.parse(body) as { request_id?: string };
        return {
          status: 200,
          body: {
            proposal: { ...VALID_PROPOSAL, request_id: parsed.request_id ?? 'rt-1' },
            openclaw_pin: '2026.9.6',
            adapter_id: 'openclaw-stage0',
          },
        };
      },
      async (url) => {
        const provider = new OpenClawBonsaiProvider({ base_url: url, token: 'tok' });
        const proposal = await provider.propose({
          request_id: 'rt-1',
          utterance: 'turn on the living room lamp',
          context: {
            known_devices: [
              {
                canonical_id: 'ha:light.living_room_lamp' as never,
                friendly_name: 'Living Room Lamp',
                aliases: ['the lamp', 'main lights'],
                room_name: 'Living Room',
              },
            ],
            known_scenes: [],
            recent_fresh_state: [],
          },
        });
        expect(proposal.intent_family).toBe('set-state');
        expect(proposal.target_phrases[0]).toBe('Living Room Lamp');
        expect(proposal.desired_values).toEqual({ on: true });
        expect(proposal.confidence).toBe(0.95);
        expect(proposal.provenance.source).toBe('bonsai');
      },
    );
  });

  it('survives one 5xx via retry, then succeeds', async () => {
    let n = 0;
    await withFakeOpenClaw(
      () => {
        n += 1;
        if (n === 1) {
          return { status: 502, body: { error: 'upstream-fail' } };
        }
        return {
          status: 200,
          body: { proposal: VALID_PROPOSAL, openclaw_pin: '2026.9.6', adapter_id: 'openclaw-stage0' },
        };
      },
      async (url) => {
        const provider = new OpenClawBonsaiProvider({ base_url: url, token: 'tok' });
        const proposal = await provider.propose({
          request_id: 'rt-2',
          utterance: 'turn off the lamp',
          context: {
            known_devices: [],
            known_scenes: [],
            recent_fresh_state: [],
          },
        });
        expect(proposal.intent_family).toBe('set-state');
        expect(n).toBe(2);
      },
    );
  });

  it('does NOT silently repair invalid proposals', async () => {
    await withFakeOpenClaw(
      () => ({
        status: 200,
        body: {
          proposal: { ...VALID_PROPOSAL, intent_family: 'teleport' },  // not in enum
          openclaw_pin: '2026.9.6',
          adapter_id: 'openclaw-stage0',
        },
      }),
      async (url) => {
        const provider = new OpenClawBonsaiProvider({ base_url: url, token: 'tok' });
        await expect(
          provider.propose({
            request_id: 'rt-3',
            utterance: 'turn on the lamp',
            context: { known_devices: [], known_scenes: [], recent_fresh_state: [] },
          }),
        ).rejects.toThrow();
      },
    );
  });
});
