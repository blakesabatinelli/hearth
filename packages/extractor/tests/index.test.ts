import { describe, it, expect, vi } from 'vitest';
import { HearthExtractHttpClient, MockGliner2 } from '../src/index.js';
import type { ExtractionSchema } from '@hearth/contracts';

const SCHEMA: ExtractionSchema = {
  schema_version: 'v1',
  entity_types: ['device_target'],
  classification_labels: ['on', 'off'],
  relations: [],
  known_aliases: [],
};

describe('HearthExtractHttpClient', () => {
  it('extract() posts to /extract and returns the parsed body', async () => {
    const fetch_fn = vi.fn(async (url: string) => {
      expect(url).toMatch(/\/extract$/);
      return new Response(
        JSON.stringify({
          request_id: 'r1',
          entities: { device_target: ['lamp'] },
          classifications: [{ label: 'on', span: 'turn on lamp' }],
          relations: [],
          unresolved: [],
          confidence: 0.9,
          original_utterance: 'turn on lamp',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new HearthExtractHttpClient({
      base_url: 'http://127.0.0.1:8765',
      fetch_fn: fetch_fn as unknown as typeof fetch,
    });
    const result = await client.extract({
      request_id: 'r1',
      utterance: 'turn on lamp',
      schema: SCHEMA,
    });
    expect(result.original_utterance).toBe('turn on lamp');
    expect(result.confidence).toBe(0.9);
    expect(result.classifications[0]?.label).toBe('on');
    expect(fetch_fn).toHaveBeenCalledTimes(1);
  });

  it('extract() throws if the sidecar drops original_utterance', async () => {
    const fetch_fn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          request_id: 'r1',
          entities: {},
          classifications: [],
          relations: [],
          unresolved: [],
          confidence: 0.9,
          // intentionally no original_utterance
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new HearthExtractHttpClient({
      base_url: 'http://127.0.0.1:8765',
      fetch_fn: fetch_fn as unknown as typeof fetch,
    });
    await expect(
      client.extract({ request_id: 'r1', utterance: 'x', schema: SCHEMA }),
    ).rejects.toThrow(/original_utterance/);
  });

  it('extract() throws on non-2xx responses', async () => {
    const fetch_fn = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new HearthExtractHttpClient({
      base_url: 'http://127.0.0.1:8765',
      fetch_fn: fetch_fn as unknown as typeof fetch,
    });
    await expect(
      client.extract({ request_id: 'r1', utterance: 'x', schema: SCHEMA }),
    ).rejects.toThrow(/500/);
  });

  it('health() returns ready=false when fetch rejects', async () => {
    const fetch_fn = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const client = new HearthExtractHttpClient({
      base_url: 'http://127.0.0.1:8765',
      fetch_fn: fetch_fn as unknown as typeof fetch,
    });
    const h = await client.health();
    expect(h.ready).toBe(false);
  });

  it('health() returns ready=true when sidecar reports ready', async () => {
    const fetch_fn = vi.fn(async () =>
      new Response(
        JSON.stringify({ ready: true, checkpoint_id: 'fastino/gliner2.5-base-v1', latency_ms_p50: 30 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new HearthExtractHttpClient({
      base_url: 'http://127.0.0.1:8765',
      fetch_fn: fetch_fn as unknown as typeof fetch,
    });
    const h = await client.health();
    expect(h.ready).toBe(true);
    expect(h.checkpoint_id).toContain('gliner2.5');
  });
});

describe('MockGliner2', () => {
  const client = new MockGliner2();
  it('extract() returns confidence ~0.85 for known phrasing', async () => {
    const r = await client.extract({
      request_id: 'm1',
      utterance: 'turn on the lamp',
      schema: SCHEMA,
    });
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.classifications.some((c) => c.label === 'on')).toBe(true);
  });
  it('extract() marks unknown utterances as unresolved', async () => {
    const r = await client.extract({
      request_id: 'm2',
      utterance: 'do the thing',
      schema: SCHEMA,
    });
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThan(0.5);
  });
  it('health() reports ready', async () => {
    const h = await client.health();
    expect(h.ready).toBe(true);
  });
});