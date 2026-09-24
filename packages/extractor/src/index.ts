/**
 * @hearth/extractor
 *
 * HTTP client for the `hearth-extract` Python sidecar (apps/extract/).
 * Implements the `ExtractionProvider` interface from `@hearth/contracts`
 * by translating between the in-process TypeScript world and the
 * FastAPI /health + /extract endpoints exposed by the sidecar.
 *
 * The contract's `ExtractionProvider.extract()` returns an `ExtractionResult`
 * that preserves `original_utterance` verbatim (ADR-2026-09-24 point 3),
 * so the resolver can pass incomplete extractions on to Bonsai with full
 * context.
 *
 * Two adapters are exported:
 *  - `HearthExtractHttpClient`     - calls a real sidecar at HEARTH_EXTRACT_URL
 *  - `mockGliner2`                 - deterministic, used in tests and CI until
 *                                    the real sidecar is deployed.
 *
 * Both adapters honour the `ExtractionProvider.health()` contract: ready
 * only when the model is loaded.
 */
import type {
  ExtractionProvider,
  ExtractionResult,
  ExtractionSchema,
} from '@hearth/contracts';

export class HearthExtractHttpClient implements ExtractionProvider {
  private readonly base_url: string;
  private readonly fetch_fn: typeof fetch;
  private readonly timeout_ms: number;
  private last_health: { ready: boolean; checkpoint_id: string; latency_ms_p50: number | null } | null = null;

  public constructor(opts: { base_url: string; fetch_fn?: typeof fetch; timeout_ms?: number }) {
    // Strip trailing slash for clean concatenation.
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.fetch_fn = opts.fetch_fn ?? ((...args) => fetch(...args));
    this.timeout_ms = opts.timeout_ms ?? 5_000;
  }

  public async extract(req: { request_id: string; utterance: string; schema: ExtractionSchema }): Promise<ExtractionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);
    try {
      const res = await this.fetch_fn(`${this.base_url}/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: req.request_id,
          utterance: req.utterance,
          schema: req.schema,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`hearth-extract /extract returned ${res.status}`);
      }
      const body = (await res.json()) as unknown;
      return this.validateAndReturn(body, req);
    } finally {
      clearTimeout(timer);
    }
  }

  public async health(): Promise<{ ready: boolean; checkpoint_id: string; latency_ms_p50: number | null }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout_ms);
      try {
        const res = await this.fetch_fn(`${this.base_url}/health`, { signal: controller.signal });
        if (!res.ok) {
          return { ready: false, checkpoint_id: 'unknown', latency_ms_p50: null };
        }
        const body = (await res.json()) as { ready?: boolean; checkpoint_id?: string; latency_ms_p50?: number | null };
        const out = {
          ready: body.ready === true,
          checkpoint_id: body.checkpoint_id ?? 'unknown',
          latency_ms_p50: body.latency_ms_p50 ?? null,
        };
        this.last_health = out;
        return out;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { ready: false, checkpoint_id: 'unknown', latency_ms_p50: null };
    }
  }

  private validateAndReturn(body: unknown, req: { request_id: string; utterance: string }): ExtractionResult {
    if (!body || typeof body !== 'object') {
      throw new Error('hearth-extract returned non-object body');
    }
    const r = body as Partial<ExtractionResult> & { original_utterance?: string };
    if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
      throw new Error('hearth-extract returned invalid confidence');
    }
    if (typeof r.original_utterance !== 'string') {
      // CRITICAL: preserve verbatim. If the sidecar strips context we fail,
      // never silently coerce (ADR point 3).
      throw new Error('hearth-extract dropped original_utterance');
    }
    return {
      request_id: typeof r.request_id === 'string' ? r.request_id : req.request_id,
      entities: r.entities ?? {},
      classifications: Array.isArray(r.classifications) ? r.classifications : [],
      relations: Array.isArray(r.relations) ? r.relations : [],
      unresolved: Array.isArray(r.unresolved) ? r.unresolved : [],
      confidence: r.confidence,
      original_utterance: r.original_utterance ?? req.utterance,
    };
  }
}

/**
 * Mock GLiNER2 provider for tests + CI. Returns deterministic output
 * keyed on the utterance hash; never reaches out to a network.
 *
 * Confidence is bounded; resolution is partial by design so the routing
 * layer exercises the "needs_bonsai" branch in tests.
 */
export class MockGliner2 implements ExtractionProvider {
  public async extract(req: { request_id: string; utterance: string; schema: ExtractionSchema }): Promise<ExtractionResult> {
    const lower = req.utterance.toLowerCase();
    const classifications: Array<{ label: import('@hearth/contracts').ExtractionLabel; span: string }> = [];
    if (/\b(turn on|switch on)\b/.test(lower)) {
      classifications.push({ label: 'on', span: req.utterance });
    } else if (/\b(turn off|switch off)\b/.test(lower)) {
      classifications.push({ label: 'off', span: req.utterance });
    } else if (/\bset\b.*\bpercent\b/.test(lower)) {
      classifications.push({ label: 'set_brightness', span: req.utterance });
    } else if (/\b(dim|brighten)\b/.test(lower)) {
      classifications.push({ label: 'dim_by', span: req.utterance });
    } else {
      // Unknown phrasing -> resolution path. Mark as unresolved so the
      // interpreter knows to route to Bonsai.
      return {
        request_id: req.request_id,
        entities: {},
        classifications: [],
        relations: [],
        unresolved: [req.utterance],
        confidence: 0.3,
        original_utterance: req.utterance,
      };
    }
    return {
      request_id: req.request_id,
      entities: {
        device_target: extractDeviceTarget(lower),
      },
      classifications,
      relations: classifications.map((c) => ({ kind: 'modifies', head: c.span, tail: 'value_expression' })),
      unresolved: extractDeviceTarget(lower).length === 0 ? ['device_target'] : [],
      confidence: 0.85,
      original_utterance: req.utterance,
    };
  }

  public async health(): Promise<{ ready: boolean; checkpoint_id: string; latency_ms_p50: number | null }> {
    return { ready: true, checkpoint_id: 'mock-gliner2-v1', latency_ms_p50: 12 };
  }
}

function extractDeviceTarget(lower_utterance: string): string[] {
  // Pull the last word-like token after "the"/"my"/"a".
  const m = lower_utterance.match(/\b(?:the|my|a)\s+([a-z][a-z\s-]+?)(?:\s+(?:to|by|until|please)|$)/);
  if (!m || !m[1]) return [];
  return [m[1].trim()];
}