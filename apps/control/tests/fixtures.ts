/**
 * Shared fixtures used by all `apps/control` tests. Returns a wired control
 * surface + an HTTP client (app.inject).
 */
import type { FastifyInstance } from 'fastify';
import { SystemClock } from '@hearth/executor';
import { InMemoryExecutionStore } from '@hearth/executor';
import { FakeHAAdapter, loadDefaultFixture } from '@hearth/ha-adapter';
import { RegistryOverlay } from '@hearth/registry';
import { wireControl, type WiredControl } from '../src/wiring.js';

export type TestControl = WiredControl & {
  injectCookie: (session_id: string) => string;
  csrfFor: (session_id: string) => string;
  tearDown: () => Promise<void>;
};

export async function buildTestControl(opts?: {
  session_secret?: string;
}): Promise<TestControl> {
  const fixture = loadDefaultFixture();
  const registry = new RegistryOverlay({
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
  };
}

/**
 * Convenience: a session create + cookie capture, returning the cookie +
 * csrf token ready to use in subsequent requests.
 */
export async function createSession(
  app: FastifyInstance,
  role: 'admin' | 'member' | 'wall-tablet' = 'admin',
): Promise<{ cookie: string; csrf: string; session_id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
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