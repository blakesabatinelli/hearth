/**
 * Shared fixtures used by all `apps/control` tests. Returns a wired control
 * surface + an HTTP client (app.inject).
 */
import type { FastifyInstance } from 'fastify';
import { SystemClock } from '@hearth/executor';
import { InMemoryExecutionStore } from '@hearth/executor';
import { FakeHAAdapter, loadDefaultFixture } from '@hearth/ha-adapter';
import { RegistryOverlay as HearthRegistryOverlay } from '@hearth/registry';
import type { HomeAssistantAdapter } from '@hearth/contracts';
import { wireControl, type WiredControl } from '../src/wiring.js';

export type TestControl = WiredControl & {
  injectCookie: (session_id: string) => string;
  csrfFor: (session_id: string) => string;
  tearDown: () => Promise<void>;
  /** The Hearth RegistryOverlay, used by scheduler/hold tests. */
  hearth_registry: HearthRegistryOverlay;
  /** The fake HA adapter, exposed so tests can verify state-version lookups. */
  adapter: HomeAssistantAdapter;
};

export async function buildTestControl(opts?: {
  session_secret?: string;
}): Promise<TestControl> {
  const fixture = loadDefaultFixture();
  const registry = new HearthRegistryOverlay({
    devices: fixture.devices,
    rooms: fixture.rooms,
    entity_version: 1,
    scene_versions: {},
  });
  const adapter = new FakeHAAdapter(fixture);
  const store = new InMemoryExecutionStore();
  const clock = new SystemClock();

  const wired = await wireControl({
    registry,
    adapter,
    store,
    clock,
    session_secret: opts?.session_secret ?? 'test-secret',
  });

  const injectCookie = (session_id: string): string =>
    wired.session_store.signCookie(session_id);

  const csrfFor = (session_id: string): string => {
    const s = wired.session_store.get(session_id);
    if (!s) throw new Error(`no session ${session_id}`);
    return s.csrf_token;
  };

  const tearDown = async (): Promise<void> => {
    await wired.app.close();
  };

  return {
    ...wired,
    injectCookie,
    csrfFor,
    tearDown,
    hearth_registry: registry,
    adapter,
  };
}

/**
 * Convenience: a session create + cookie capture, returning the cookie +
 * csrf token ready to use in subsequent requests.
 *
 * In test mode (HEARTH_ALLOW_DEV_ADMIN=1 in vitest config) we treat admin
 * sessions as ambient-allowed so tests don't need to send admin-grant
 * headers. Production must never set HEARTH_ALLOW_DEV_ADMIN.
 */
export async function createSession(
  app: FastifyInstance,
  role: 'admin' | 'member' | 'wall-tablet' = 'admin',
  opts?: { dev_token?: string; admin_grant?: boolean },
): Promise<{ cookie: string; csrf: string; session_id: string }> {
  process.env['HEARTH_ALLOW_DEV_ADMIN'] = '1';
  const headers: Record<string, string> = {};
  if (opts?.dev_token) headers['x-hearth-dev-token'] = opts.dev_token;
  if (role === 'admin' && opts?.admin_grant) headers['x-hearth-admin-grant'] = 'granted';
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: { role },
  });
  if (res.statusCode !== 200) {
    throw new Error(`session create failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { session_id: string; csrf_token: string };
  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  if (!cookie) throw new Error('no set-cookie returned');
  // Extract just the name=value part before `;`
  const cookieHeader = cookie.split(';')[0] ?? '';
  return {
    cookie: cookieHeader,
    csrf: body.csrf_token,
    session_id: body.session_id,
  };
}

export function csrfHeaders(csrf: string): Record<string, string> {
  return { 'x-hearth-csrf': csrf };
}

/**
 * Helper for tests: build a proposal via /v1/interpret and return the
 * proposal + receipt, ready to POST to /v1/contracts. v3.0.1: tests must
 * flow through this just like real clients.
 */
export async function issueProposal(
  app: FastifyInstance,
  cookie: string,
  csrf: string,
  utterance: string,
  request_id: string,
): Promise<{ proposal: unknown; proposal_receipt: string; request_id: string }> {
  process.env['HEARTH_ALLOW_DEV_ADMIN'] = '1';
  const res = await app.inject({
    method: 'POST',
    url: '/v1/interpret',
    headers: { cookie, 'x-hearth-csrf': csrf },
    payload: { utterance, request_id },
  });
  if (res.statusCode !== 200) {
    throw new Error(`interpret failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as {
    outcome: string;
    proposal?: unknown;
    proposal_receipt: string;
    request_id: string;
  };
  if (body.outcome !== 'ready_for_contract' || !body.proposal || !body.proposal_receipt) {
    throw new Error(`interpret did not yield a ready proposal: ${res.body}`);
  }
  return { proposal: body.proposal, proposal_receipt: body.proposal_receipt, request_id: body.request_id };
}

/**
 * Helper for tests: POST /v1/contracts with a proposal + receipt.
 */
export async function createContract(
  app: FastifyInstance,
  cookie: string,
  csrf: string,
  proposal: unknown,
  proposal_receipt: string,
  request_id: string,
  expiry_seconds?: number,
): Promise<{ statusCode: number; body: string }> {
  const payload: Record<string, unknown> = {
    proposal,
    proposal_receipt,
    request_id,
  };
  if (expiry_seconds !== undefined) payload['expiry_seconds'] = expiry_seconds;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/contracts',
    headers: { cookie, 'x-hearth-csrf': csrf },
    payload,
  });
  return { statusCode: res.statusCode, body: res.body };
}