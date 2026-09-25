/**
 * OpenClawBonsaiProvider -- the Hearth-side adapter for the OpenClaw
 * external Gateway.
 *
 * Lifecycle:
 *   const provider = new OpenClawBonsaiProvider({
 *     base_url: 'http://127.0.0.1:8443',  // loopback only
 *     token: process.env.HEARTH_GATEWAY_TOKEN!,
 *     fetch_impl: ...,                      // optional, test seam
 *   });
 *   const proposal = await provider.propose({ request_id, utterance, context });
 *
 * Each call:
 *   1. Sends POST {base_url}/agent/turn with bearer auth.
 *   2. Receives JSON. Validates strictly. Throws on invalid.
 *   3. One retry on transient network error only.
 *
 * The provider does NOT carry any device-control authority. The
 * caller (interpreter) and downstream code paths decide what becomes
 * a contract.
 */

import type {
  BonsaiProvider,
  IntentProposal,
  ProposalContext,
} from '@hearth/contracts';
import {
  HEARTH_OPENCLAW_PIN,
} from '@hearth/contracts';
import {
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_SCHEMA_VERSION,
  assertLoopbackOnly,
  buildSystemPrompt,
  buildUserPrompt,
  validateProposalRaw,
  ProposalValidationError,
} from './protocol.js';

export interface OpenClawBonsaiProviderOptions {
  /** Loopback-only URL of the OpenClaw external Gateway. */
  readonly base_url: string;
  /** Bearer token. Loaded by main.ts from $HEARTH_SECRET_DIR/openclaw-gateway-token. */
  readonly token: string;
  /** Optional fetch override; defaults to globalThis.fetch (Node 20+). */
  readonly fetch_impl?: typeof fetch;
  /** Hard timeout per request. Default 30s. */
  readonly timeout_ms?: number;
  /** Optional adapter_id; propagated into provenance. Default 'openclaw'. */
  readonly adapter_id?: string;
  /** Pin the OpenClaw protocol version. Defaults to HEARTH_OPENCLAW_PIN. */
  readonly expected_pin?: string;
}

export interface OpenClawTurnResponse {
  /** The model's JSON output, parsed. May be invalid; the caller validates. */
  readonly raw: unknown;
  /** Status returned by the gateway. */
  readonly status: number;
  /** Adapter id echoed back. */
  readonly adapter_id: string;
  /** Schema version declared by the model. May not match ours. */
  readonly schema_version: string | null;
}

export interface ProposalStrictSchema {
  readonly schema_version: string;
  readonly schema: typeof PROPOSAL_JSON_SCHEMA;
}

/**
 * Thrown when the OpenClaw Gateway returns a 5xx or the network errors.
 * Retried once; failure here surfaces to the interpreter, which then
 * may decide to clarify.
 */
export class OpenClawTransientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenClawTransientError';
  }
}

/**
 * Thrown when the OpenClaw Gateway returns a 4xx, or any other
 * non-transient failure mode. Not retried.
 */
export class OpenClawPermanentError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenClawPermanentError';
  }
}

export class OpenClawPinError extends Error {
  constructor(pin: string) {
    super(`OpenClaw gateway reported pin ${pin}; expected ${HEARTH_OPENCLAW_PIN}`);
    this.name = 'OpenClawPinError';
  }
}

export class OpenClawBonsaiProvider implements BonsaiProvider {
  readonly base_url: string;
  readonly token: string;
  readonly timeout_ms: number;
  readonly adapter_id: string;
  readonly expected_pin: string;
  private readonly fetch_impl: typeof fetch;

  constructor(opts: OpenClawBonsaiProviderOptions) {
    assertLoopbackOnly(opts.base_url);
    this.base_url = opts.base_url.replace(/\/$/, '');
    this.token = opts.token;
    this.timeout_ms = opts.timeout_ms ?? 30_000;
    this.adapter_id = opts.adapter_id ?? 'openclaw';
    this.expected_pin = opts.expected_pin ?? HEARTH_OPENCLAW_PIN;
    this.fetch_impl = opts.fetch_impl ?? (globalThis.fetch as typeof fetch);
  }

  /**
   * Issue a strict JSON schema to the model. Hearth assumes the model
   * honors schema-constrained generation (Bonsai 27B 1-bit quantized
   * on Metal does when guided by OpenClaw's prompt-shaping).
   *
   * The returned shape is preserved without modification by the
   * provider for debugging; validation happens in validateProposal.
   */
  turn(req: { request_id: string; utterance: string; context: ProposalContext }): Promise<OpenClawTurnResponse> {
    return this.call_with_retry(req);
  }

  /**
   * BonsaiProvider interface: validate and emit IntentProposal.
   */
  async propose(req: { request_id: string; utterance: string; context: ProposalContext }): Promise<IntentProposal> {
    const resp = await this.turn(req);
    return this.validateProposal(resp.raw);
  }

  /**
   * BonsaiProvider interface: validate the model's raw output and
   * return a typed IntentProposal. Throws ProposalValidationError
   * on the first failure.
   */
  validateProposal(raw: unknown): IntentProposal {
    return validateProposalRaw(raw);
  }

  // -------------------------------------------------------------------------
  // Private: HTTP call + retry policy
  // -------------------------------------------------------------------------

  private async call_with_retry(req: {
    request_id: string;
    utterance: string;
    context: ProposalContext;
  }): Promise<OpenClawTurnResponse> {
    let attempt = 0;
    let last_err: unknown = null;
    while (attempt < 2) {
      attempt += 1;
      try {
        return await this.call_once(req);
      } catch (e) {
        last_err = e;
        // OpenClawTransientError: retry once
        // ProposalValidationError, OpenClawPermanentError, OpenClawPinError:
        // pass through immediately without retry.
        if (!(e instanceof OpenClawTransientError)) {
          throw e;
        }
        if (attempt >= 2) {
          throw e;
        }
      }
    }
    // Should be unreachable but fail closed.
    throw last_err instanceof Error ? last_err : new Error('openclaw: retries exhausted');
  }

  private async call_once(req: {
    request_id: string;
    utterance: string;
    context: ProposalContext;
  }): Promise<OpenClawTurnResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);
    let res: Response;
    try {
      const body = {
        system: buildSystemPrompt(),
        user: buildUserPrompt(req),
        schema: PROPOSAL_JSON_SCHEMA,
        schema_version: PROPOSAL_SCHEMA_VERSION,
        tool: 'bonsai_thinking',
        request_id: req.request_id,
        adapter_id: this.adapter_id,
      };
      res = await this.fetch_impl(`${this.base_url}/agent/turn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          'X-OpenClaw-Pin': this.expected_pin,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new OpenClawTransientError(
        `openclaw network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    clearTimeout(timer);

    if (res.status >= 500) {
      throw new OpenClawTransientError(`openclaw gateway returned ${res.status}`, res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OpenClawPermanentError(`openclaw auth failed: ${res.status}`, res.status);
    }
    if (res.status >= 400) {
      throw new OpenClawPermanentError(`openclaw gateway returned ${res.status}`, res.status);
    }
    if (!res.ok) {
      throw new OpenClawPermanentError(`openclaw gateway returned ${res.status}`, res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new OpenClawPermanentError(`openclaw returned non-JSON body (status ${res.status})`, res.status);
    }
    if (typeof json !== 'object' || json === null) {
      throw new OpenClawPermanentError('openclaw response body is not an object');
    }
    const obj = json as Record<string, unknown>;
    const pin = obj['openclaw_pin'];
    if (typeof pin === 'string' && pin !== this.expected_pin) {
      // Pin drift. Refuse to use the response.
      throw new OpenClawPinError(pin);
    }
    return {
      raw: obj['proposal'] ?? obj,
      status: res.status,
      adapter_id: typeof obj['adapter_id'] === 'string' ? (obj['adapter_id'] as string) : this.adapter_id,
      schema_version: typeof obj['schema_version'] === 'string' ? (obj['schema_version'] as string) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Re-export ProposalValidationError for downstream call sites
// ---------------------------------------------------------------------------

export { ProposalValidationError } from './protocol.js';
