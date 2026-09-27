/** Hearth's restricted client for the pinned OpenClaw Gateway. */

import { GatewayClient } from '@openclaw/gateway-client';
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version';
import type { BonsaiProvider, IntentProposal, ProposalContext } from '@hearth/contracts';
import { HEARTH_OPENCLAW_PIN } from '@hearth/contracts';
import {
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_SCHEMA_VERSION,
  assertLoopbackOnly,
  buildSystemPrompt,
  buildUserPrompt,
  validateProposalRaw,
  ProposalValidationError,
} from './protocol.js';

type GatewayEvent = { event?: string; payload?: unknown };
type GatewayClientLike = {
  start(): void;
  stopAndWait(options?: { timeoutMs?: number }): Promise<void>;
  request(method: string, params?: unknown, options?: { timeoutMs?: number | null }): Promise<unknown>;
};

export interface OpenClawBonsaiProviderOptions {
  /** Loopback URL of the OpenClaw Gateway, for example http://127.0.0.1:18789. */
  readonly base_url: string;
  /** Gateway auth token. */
  readonly token: string;
  /** Hard deadline for the complete model turn. Default 300s for local inference. */
  readonly timeout_ms?: number;
  readonly adapter_id?: string;
  readonly expected_pin?: string;
  /** Test seam for Gateway protocol behavior. */
  readonly client_factory?: (options: ConstructorParameters<typeof GatewayClient>[0]) => GatewayClientLike;
}

export interface OpenClawTurnResponse {
  readonly raw: unknown;
  readonly status: number;
  readonly adapter_id: string;
  readonly schema_version: string | null;
}

export interface ProposalStrictSchema {
  readonly schema_version: string;
  readonly schema: typeof PROPOSAL_JSON_SCHEMA;
}

export class OpenClawTransientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenClawTransientError';
  }
}

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

function gatewayWsUrl(base_url: string): string {
  const url = new URL(base_url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

function readAssistantText(event: GatewayEvent, runId: string): string | undefined {
  if (event.event !== 'agent' || typeof event.payload !== 'object' || event.payload === null) return;
  const payload = event.payload as Record<string, unknown>;
  if (payload.runId !== runId || payload.stream !== 'assistant') return;
  const data = payload.data;
  if (typeof data === 'string') return data;
  if (typeof data !== 'object' || data === null) return;
  const obj = data as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.delta === 'string') return obj.delta;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new ProposalValidationError('Bonsai response was not valid JSON', '$', text);
  }
}

export class OpenClawBonsaiProvider implements BonsaiProvider {
  readonly base_url: string;
  readonly token: string;
  readonly timeout_ms: number;
  readonly adapter_id: string;
  readonly expected_pin: string;
  private readonly client_factory: (options: ConstructorParameters<typeof GatewayClient>[0]) => GatewayClientLike;

  constructor(opts: OpenClawBonsaiProviderOptions) {
    assertLoopbackOnly(opts.base_url);
    this.base_url = opts.base_url.replace(/\/$/, '');
    this.token = opts.token;
    this.timeout_ms = opts.timeout_ms ?? 300_000;
    this.adapter_id = opts.adapter_id ?? 'openclaw';
    this.expected_pin = opts.expected_pin ?? HEARTH_OPENCLAW_PIN;
    this.client_factory = opts.client_factory ?? ((options) => new GatewayClient(options));
  }

  async turn(req: { request_id: string; utterance: string; context: ProposalContext }): Promise<OpenClawTurnResponse> {
    const outputEvents: Array<{ runId: string; text: string }> = [];
    let runId: string | undefined;
    let connectReject: ((error: Error) => void) | undefined;
    let connectResolve: (() => void) | undefined;
    const connected = new Promise<void>((resolve, reject) => { connectResolve = resolve; connectReject = reject; });
    let gateway_pin: string | undefined;
    const client = this.client_factory({
      url: gatewayWsUrl(this.base_url),
      token: this.token,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      requestTimeoutMs: this.timeout_ms,
      clientName: 'gateway-client',
      mode: 'backend',
      clientDisplayName: 'Hearth',
      role: 'operator',
      scopes: ['operator.write'],
      onHelloOk: (hello) => {
        gateway_pin = hello?.server?.version;
        connectResolve?.();
      },
      onConnectError: (error) => connectReject?.(error),
      onEvent: (event) => {
        const frame = event as GatewayEvent;
        if (frame.event !== 'agent' || typeof frame.payload !== 'object' || frame.payload === null) return;
        const payload = frame.payload as Record<string, unknown>;
        if (typeof payload.runId !== 'string') return;
        const text = readAssistantText(frame, payload.runId);
        if (text) outputEvents.push({ runId: payload.runId, text });
      },
    });

    const deadline = setTimeout(() => connectReject?.(new Error('Gateway connect timed out')), this.timeout_ms);
    try {
      client.start();
      await connected;
      clearTimeout(deadline);
      if (gateway_pin && gateway_pin !== this.expected_pin) throw new OpenClawPinError(gateway_pin);
      const acceptedRaw = await client.request('agent', {
        message: `${buildSystemPrompt()}\n\n${buildUserPrompt(req)}`,
        sessionKey: `hearth-${req.request_id}`,
        idempotencyKey: req.request_id,
        thinking: 'off',
        timeout: Math.max(1, Math.ceil(this.timeout_ms / 1_000)),
        promptMode: 'none',
        modelRun: true,
        disableMessageTool: true,
      }, { timeoutMs: this.timeout_ms });
      const accepted = typeof acceptedRaw === 'object' && acceptedRaw !== null ? acceptedRaw as { runId?: unknown } : {};
      if (typeof accepted.runId !== 'string' || !accepted.runId) {
        throw new OpenClawPermanentError('OpenClaw Gateway did not acknowledge the agent run');
      }
      runId = accepted.runId;
      const runDeadline = Date.now() + this.timeout_ms;
      let completion: { status?: string; error?: string; terminalReply?: unknown } = {};
      while (Date.now() < runDeadline) {
        const remaining = runDeadline - Date.now();
        const waitMs = Math.max(1, Math.min(15_000, remaining));
        const completionRaw = await client.request('agent.wait', {
          runId,
          timeoutMs: waitMs,
        }, { timeoutMs: waitMs + 2_000 });
        completion = typeof completionRaw === 'object' && completionRaw !== null ? completionRaw as { status?: string; error?: string; terminalReply?: unknown } : {};
        if (completion.status !== 'timeout' && completion.status !== 'pending') break;
      }
      if (completion.status === 'timeout' || completion.status === 'pending') {
        // agent.wait timeouts only end that observation. Explicitly abort
        // the exact run when Hearth's overall inference deadline expires.
        await client.request('sessions.abort', { runId }, { timeoutMs: 5_000 }).catch(() => undefined);
        throw new OpenClawTransientError(`OpenClaw Bonsai inference timed out after ${this.timeout_ms}ms`);
      }
      if (completion.status !== 'ok' && completion.status !== 'completed') {
        throw new OpenClawTransientError(`OpenClaw agent run ended with status ${completion.status ?? 'unknown'}${completion.error ? `: ${completion.error}` : ''}`);
      }
      const streamedText = outputEvents.filter((event) => event.runId === runId).map((event) => event.text).join('');
      const terminalReply = typeof completion.terminalReply === 'object' && completion.terminalReply !== null
        ? completion.terminalReply as { disposition?: string; text?: unknown }
        : {};
      const replyText = streamedText || (terminalReply.disposition === 'visible' && typeof terminalReply.text === 'string'
        ? terminalReply.text
        : '');
      const raw = extractJson(replyText);
      return {
        raw,
        status: 200,
        adapter_id: this.adapter_id,
        schema_version: PROPOSAL_SCHEMA_VERSION,
      };
    } catch (error) {
      if (error instanceof ProposalValidationError || error instanceof OpenClawPermanentError || error instanceof OpenClawPinError || error instanceof OpenClawTransientError) throw error;
      throw new OpenClawTransientError(`OpenClaw Gateway request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(deadline);
      await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => undefined);
    }
  }

  async propose(req: { request_id: string; utterance: string; context: ProposalContext }): Promise<IntentProposal> {
    const response = await this.turn(req);
    const proposal = this.validateProposal(response.raw);
    if (proposal.request_id !== req.request_id) {
      throw new ProposalValidationError('request_id does not match the Hearth request', '$.request_id', proposal.request_id);
    }
    return proposal;
  }

  validateProposal(raw: unknown): IntentProposal {
    return validateProposalRaw(raw);
  }
}

/** Verify the Gateway WebSocket handshake and token without invoking a model. */
export async function probeOpenClawGateway(base_url: string, token: string, timeout_ms = 5_000): Promise<void> {
  assertLoopbackOnly(base_url);
  let rejectConnect: ((error: Error) => void) | undefined;
  let resolveConnect: (() => void) | undefined;
  const connected = new Promise<void>((resolve, reject) => { resolveConnect = resolve; rejectConnect = reject; });
  let gateway_pin: string | undefined;
  const client = new GatewayClient({
    url: gatewayWsUrl(base_url),
    token,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    requestTimeoutMs: timeout_ms,
    clientName: 'gateway-client',
    clientDisplayName: 'Hearth Doctor',
    mode: 'backend',
    role: 'operator',
    scopes: ['operator.write'],
    onHelloOk: (hello) => {
      gateway_pin = hello?.server?.version;
      resolveConnect?.();
    },
    onConnectError: (error) => rejectConnect?.(error),
  });
  const timer = setTimeout(() => rejectConnect?.(new Error('Gateway handshake timed out')), timeout_ms);
  try {
    client.start();
    await connected;
    if (gateway_pin && gateway_pin !== HEARTH_OPENCLAW_PIN) throw new OpenClawPinError(gateway_pin);
  } finally {
    clearTimeout(timer);
    await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => undefined);
  }
}

export { ProposalValidationError } from './protocol.js';
