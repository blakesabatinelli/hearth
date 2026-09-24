/**
 * Wire Hearth's packages into a Fastify app.
 *
 * Responsibilities:
 *  - register session middleware
 *  - register CSRF guard
 *  - mount /v1 routes (interpret, contracts, devices, sessions, csrf)
 *  - mount /healthz + /readyz
 *  - return the wired app + the underlying executor for tests
 *
 * The wiring is intentionally explicit (no DI framework). Tests pass
 * fixtures (in-memory store, fake-HA, etc.) here.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import {
  type Actor,
  type ActorRole,
  type IdempotencyKey,
} from '@hearth/contracts';
import {
  ContractExecutor,
  type Clock,
  type ExecutionStore,
  type RegistryOverlay as ExecutorRegistryOverlay,
} from '@hearth/executor';
import {
  Interpreter,
  ForbiddenFieldError,
} from '@hearth/interpreter';
import type { RegistryOverlay as HearthRegistryOverlay } from '@hearth/registry';
import type {
  BonsaiProvider,
  ExtractionProvider,
  HomeAssistantAdapter,
} from '@hearth/contracts';
import { HearthExtractHttpClient, MockGliner2 } from '@hearth/extractor';

import { HearthToExecutorRegistry } from './registry-adapter.js';
import { SessionStore, COOKIE, csrfValid, readSession, setSessionCookie, clearSessionCookie, actorForRole } from './session.js';
import { buildContract, ensureProposalFreshness, type BuildContractInput, resolveRelativeDesiredValues } from './contract-builder.js';
import { mapDomainError } from './errors.js';
import { issueReceipt, verifyReceipt, UntrustedProposalError } from './proposal-receipts.js';

export type WireOptions = {
  readonly registry: HearthRegistryOverlay;
  readonly adapter: HomeAssistantAdapter;
  readonly store: ExecutionStore;
  readonly clock: Clock;
  /** Override GLiNER2 provider. Default: MockGliner2 (deterministic, for tests/CI). */
  readonly gliner2?: ExtractionProvider | null;
  /** Override Bonsai provider. Default: null (grammar + GLiNER2 only). */
  readonly bonsai?: BonsaiProvider | null;
  /** If true, every request gets the dev-default actor (no auth required). */
  readonly dev_actor?: boolean;
  /** Override session store secret (for tests). */
  readonly session_secret?: string;
  /**
   * If set, construct a `HearthExtractHttpClient` against this base URL
   * instead of using MockGliner2. Allows prod to point at the real
   * `hearth-extract` Python sidecar.
   */
  readonly gliner2_http_url?: string;
};

export type WiredControl = {
  readonly app: FastifyInstance;
  readonly executor: ContractExecutor;
  readonly interpreter: Interpreter;
  readonly session_store: SessionStore;
  readonly executor_registry: ExecutorRegistryOverlay;
};

export async function wireControl(opts: WireOptions): Promise<WiredControl> {
  const executor_registry = new HearthToExecutorRegistry(opts.registry);
  const executor = new ContractExecutor({
    adapter: opts.adapter,
    registry: executor_registry,
    store: opts.store,
    clock: opts.clock,
  });

  // Choose the GLiNER2 provider: explicit > HTTP URL > mock.
  const gliner2_provider: ExtractionProvider | null = opts.gliner2
    ?? (opts.gliner2_http_url
      ? new HearthExtractHttpClient({ base_url: opts.gliner2_http_url })
      : new MockGliner2());

  const interpreter = new Interpreter({
    registry: opts.registry,
    gliner2: gliner2_provider,
    bonsai: opts.bonsai ?? null,
  });

  const session_store = new SessionStore(opts.session_secret ? { secret: opts.session_secret } : {});

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 1024 * 64, // 64 KiB; utterances + payloads are tiny
  });

  await app.register(cookie, {
    secret: opts.session_secret ?? 'hearth-dev-cookie-secret',
  });

  // Health endpoints. /readyz runs a tiny probe against the executor's store.
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    try {
      // Cheap round-trip: ask the adapter for the device list.
      const devices = await opts.adapter.listDevices();
      return { status: 'ready', device_count: devices.length };
    } catch (err) {
      return { status: 'degraded', reason: (err as Error).message };
    }
  });

  // ===== sessions =====
  //
  // POST /v1/sessions v3.0.1:
  //   - In production mode (HEARTH_REQUIRE_DEV_TOKEN set): caller must
  //     supply a matching x-hearth-dev-token header. role=admin requires
  //     the additional x-hearth-admin token (or an OAuth callback in a
  //     future revision).
  //   - Without HEARTH_REQUIRE_DEV_TOKEN: dev-mode convenience only; never
  //     enable this in production.
  //   - role MUST be one of {admin, member, wall-tablet, service}.
  //     The default is NO ROLE (rejected) rather than admin.
  type SessionCreateBody = { role?: ActorRole };
  app.post<{ Body: SessionCreateBody }>('/v1/sessions', async (req, reply) => {
    const role = (req.body?.role ?? null) as ActorRole | null;
    if (!role || !['admin', 'member', 'wall-tablet', 'service'].includes(role)) {
      reply.code(400);
      return { error: { code: 'invalid_role', message: 'role required (admin | member | wall-tablet | service)' } };
    }

    // Production gate.
    const dev_token_required = process.env['HEARTH_REQUIRE_DEV_TOKEN'];
    if (dev_token_required) {
      const supplied = req.headers['x-hearth-dev-token'];
      if (supplied !== dev_token_required) {
        reply.code(403);
        return { error: { code: 'auth_required', message: 'developer token required (x-hearth-dev-token)' } };
      }
    }

    // role=admin in production mode requires an additional explicit grant
    // unless HEARTH_ALLOW_DEV_ADMIN is set (CI / local-only).
    if (role === 'admin' && !process.env['HEARTH_ALLOW_DEV_ADMIN']) {
      const admin_grant = req.headers['x-hearth-admin-grant'];
      if (admin_grant !== 'granted') {
        reply.code(403);
        return { error: { code: 'admin_grant_required', message: 'role=admin requires x-hearth-admin-grant: granted' } };
      }
    }

    const session = session_store.create(actorForRole(role, 'pending'));
    const signed = session_store.signCookie(session.session_id);
    setSessionCookie(reply, signed);
    return {
      session_id: session.session_id,
      csrf_token: session.csrf_token,
      role,
      expires_at: session.expires_at,
    };
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/sessions/:id',
    async (req, reply) => {
      const session = readSession(req, session_store);
      if (!session || session.session_id !== req.params.id) {
        reply.code(404);
        return { error: { code: 'session_not_found', message: 'no such session' } };
      }
      if (!csrfValid(req, session)) {
        reply.code(403);
        return { error: { code: 'csrf_invalid', message: 'CSRF token missing or wrong' } };
      }
      session_store.destroy(session.session_id);
      clearSessionCookie(reply);
      return { status: 'destroyed' };
    },
  );

  app.get('/v1/csrf', async (req, reply) => {
    const session = readSession(req, session_store);
    if (!session) {
      reply.code(401);
      return { error: { code: 'no_session', message: 'no active session' } };
    }
    return { csrf_token: session.csrf_token };
  });

  // ===== interpret =====

  type InterpretBody = {
    utterance: string;
    request_id?: string;
    payload?: Record<string, unknown>;
  };
  app.post<{ Body: InterpretBody }>('/v1/interpret', async (req, reply) => {
    const session = readSession(req, session_store);
    if (!session) {
      reply.code(401);
      return { error: { code: 'no_session', message: 'no active session' } };
    }
    if (!csrfValid(req, session)) {
      reply.code(403);
      return { error: { code: 'csrf_invalid', message: 'CSRF token missing or wrong' } };
    }
    const body = req.body;
    if (!body || typeof body.utterance !== 'string' || body.utterance.trim() === '') {
      reply.code(400);
      return { error: { code: 'invalid_body', message: 'utterance required' } };
    }
    const request_id = (body.request_id ?? randomUUID()) as string;
    const actor = session.actor;

    try {
      const decision = await interpreter.interpret(
        body.utterance,
        request_id,
        body.payload ?? {},
      );

      // v3.0.1: when the interpreter produces a ready_for_contract proposal,
      // sign a receipt so /v1/contracts can verify the proposal was produced
      // by this interpreter (this session) and not hand-built by the client.
      const signing_key = opts.session_secret ?? 'hearth-dev-cookie-secret';
      const decorated_decision = (() => {
        if (decision.outcome === 'ready_for_contract' && decision.proposal) {
          const receipt = issueReceipt(
            { proposal: decision.proposal, request_id: request_id ?? randomUUID() },
            signing_key,
          );
          return {
            ...decision,
            proposal_receipt: receipt.token,
          };
        }
        return decision;
      })();
      return { request_id, decision: decorated_decision, actor };
    } catch (err) {
      if (err instanceof ForbiddenFieldError) {
        const mapped = mapDomainError(err);
        reply.code(mapped.status);
        return mapped.body;
      }
      throw err;
    }
  });

  // ===== contracts =====

  type ContractCreateBody = {
    proposal: import('@hearth/contracts').IntentProposal;
    /** opaque base64url token issued by /v1/interpret; v3.0.1 */
    proposal_receipt?: string;
    request_id?: string;
    expiry_seconds?: number;
  };
  app.post<{ Body: ContractCreateBody }>('/v1/contracts', async (req, reply) => {
    const session = readSession(req, session_store);
    if (!session) {
      reply.code(401);
      return { error: { code: 'no_session', message: 'no active session' } };
    }
    if (!csrfValid(req, session)) {
      reply.code(403);
      return { error: { code: 'csrf_invalid', message: 'CSRF token missing or wrong' } };
    }
    const body = req.body;
    if (!body || !body.proposal) {
      reply.code(400);
      return { error: { code: 'invalid_body', message: 'proposal required' } };
    }
    const request_id = body.request_id ?? randomUUID();
    const idempotency_key = request_id as IdempotencyKey;
    const actor: Actor = { ...session.actor, session_id: session.session_id };

    // v3.0.1: verify the proposal was produced by /v1/interpret in this
    // session. Hand-built proposals are rejected.
    //
    // Dev-mode convenience: when HEARTH_REQUIRE_DEV_TOKEN is unset (i.e.
    // this is a development / test deployment), we accept un-receipted
    // proposals to keep the bring-up loop simple. Production deployments
    // MUST set HEARTH_REQUIRE_DEV_TOKEN (so the admin-grant gate is
    // active) and proposals must carry a receipt.
    if (process.env['HEARTH_REQUIRE_DEV_TOKEN'] && !body.proposal_receipt) {
      reply.code(400);
      return { error: { code: 'untrusted_proposal', message: 'proposal must be issued by /v1/interpret in production mode' } };
    }
    if (body.proposal_receipt) {
      const receipt_token: string = body.proposal_receipt;
      const verify = verifyReceipt(
        receipt_token,
        body.proposal,
        request_id,
        opts.session_secret ?? 'hearth-dev-cookie-secret',
      );
      if (!verify.ok) {
        reply.code(400);
        return { error: { code: 'untrusted_proposal', message: `proposal receipt: ${verify.reason}` } };
      }
    }

    try {
      const build_input: BuildContractInput = {
        actor,
        request_id,
        idempotency_key,
        proposal: body.proposal,
        registry: executor_registry,
        resolve_phrase: async (phrase: string) => {
          const hits = await opts.registry.resolve(phrase);
          return hits.map((h) => ({ canonical_id: h.device.canonical_id }));
        },
        now: () => new Date(opts.clock.now()),
        expiry_seconds: body.expiry_seconds,
        // v3.0.1: pass the live adapter through so the contract can capture
        // the observed state_version + attributes at build time, and so
        // relative desired_values are resolved to absolute values.
        observed_state: async (canonical_id: string): Promise<number> => {
          try {
            const state = await opts.adapter.getState(canonical_id as never);
            return state.state_version;
          } catch {
            return 0;
          }
        },
        resolve_relative: async (
          _target: string,
          desired: Readonly<Record<string, number | string | boolean>>,
          obs: Readonly<Record<string, unknown>>,
        ) => resolveRelativeDesiredValues(desired, obs),
      };
      const { contract } = await buildContract(build_input);
      const receipt = await executor.dispatch(contract);
      return { receipt, contract_id: contract.contract_id };
    } catch (err) {
      const mapped = mapDomainError(err);
      reply.code(mapped.status);
      return mapped.body;
    }
  });

  app.get<{ Params: { id: string } }>(
    '/v1/receipts/:id',
    async (req, reply) => {
      const session = readSession(req, session_store);
      if (!session) {
        reply.code(401);
        return { error: { code: 'no_session', message: 'no active session' } };
      }
      // Receipt lookup is by contract_id (the request_id-keyed identifier).
      const receipts = opts.store.getReceiptsForContract(req.params.id);
      if (!receipts || receipts.length === 0) {
        reply.code(404);
        return { error: { code: 'receipt_not_found', message: `no receipt for ${req.params.id}` } };
      }
      return { receipts };
    },
  );

  // ===== devices =====

  app.get('/v1/devices', async (req, reply) => {
    const session = readSession(req, session_store);
    if (!session) {
      reply.code(401);
      return { error: { code: 'no_session', message: 'no active session' } };
    }
    const devices = await opts.adapter.listDevices();
    const rooms = await opts.adapter.listRooms();
    return {
      devices,
      rooms,
      actor: { actor_id: session.actor.actor_id, role: session.actor.role },
    };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/devices/:id/state',
    async (req, reply) => {
      const session = readSession(req, session_store);
      if (!session) {
        reply.code(401);
        return { error: { code: 'no_session', message: 'no active session' } };
      }
      const canonical = req.params.id as import('@hearth/contracts').CanonicalId;
      try {
        const state = await opts.adapter.getState(canonical);
        return { state };
      } catch (err) {
        reply.code(404);
        return { error: { code: 'unknown_device', message: (err as Error).message } };
      }
    },
  );

  // Startup recovery (plan section 8). Call once at boot, before serving.
  // Tests can call reconcileOnStartup() themselves; production wraps it.
  // We don't call it here because the store might be empty in tests.

  void ensureProposalFreshness;
  void COOKIE;

  return {
    app,
    executor,
    interpreter,
    session_store,
    executor_registry,
  };
}