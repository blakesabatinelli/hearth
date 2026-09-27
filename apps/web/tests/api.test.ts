/**
 * api.ts unit tests.
 *
 * Covers:
 *  - createSession stores only session metadata; the browser owns the HttpOnly cookie
 *  - POST /v1/interpret sends x-hearth-csrf header (state-changing)
 *  - GET /v1/devices does NOT send x-hearth-csrf (safe method)
 *  - non-2xx responses surface as ApiError with status
 *  - ensureSession is idempotent
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HearthApi,
  ApiError,
} from '../src/api';

beforeEach(() => sessionStorage.clear());

function jsonResponse(body: unknown, init: { status?: number; setCookie?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.setCookie) headers['set-cookie'] = init.setCookie;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('HearthApi.createSession', () => {
  it('uses an admin session by default for the local PWA', async () => {
    let requestBody = '';
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return jsonResponse(
        { session_id: 'sess-admin', csrf_token: 'csrf-admin', role: 'admin', expires_at: '' },
        { setCookie: 'hearth_session=admin-cookie; Path=/' },
      );
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.ensureSession();
    expect(JSON.parse(requestBody)).toEqual({ role: 'admin' });
    expect(sessionStorage.getItem('hearth.role')).toBe('admin');
  });

  it('replaces a previously cached member session with local admin access', async () => {
    sessionStorage.setItem('hearth.session_id', 'old-session');
    sessionStorage.setItem('hearth.csrf_token', 'old-csrf');
    sessionStorage.setItem('hearth.cookie', 'hearth_session=old-cookie');
    sessionStorage.setItem('hearth.role', 'member');
    const fetchMock = vi.fn(async () => jsonResponse(
      { session_id: 'new-session', csrf_token: 'new-csrf', role: 'admin', expires_at: '' },
      { setCookie: 'hearth_session=new-cookie; Path=/' },
    ));
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    const session = await api.ensureSession();
    expect(session.role).toBe('admin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('hearth.role')).toBe('admin');
  });

  it('stores session metadata without reading the HttpOnly cookie', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          session_id: 'sess-1',
          csrf_token: 'csrf-1',
          role: 'admin',
          expires_at: '2027-01-01T00:00:00.000Z',
        },
        { setCookie: 'hearth_session=abc123; Path=/; HttpOnly; SameSite=Lax' },
      ),
    );
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');

    expect(api.getCsrf()).toBe('csrf-1');
    expect(api.getSessionId()).toBe('sess-1');
    expect(sessionStorage.getItem('hearth.cookie')).toBeNull();
    expect(sessionStorage.getItem('hearth.csrf_token')).toBe('csrf-1');
    expect(sessionStorage.getItem('hearth.session_id')).toBe('sess-1');
  });

  it('does not require JavaScript to read the HttpOnly Set-Cookie header', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ session_id: 'x', csrf_token: 'y', role: 'admin', expires_at: '' }),
    );
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(api.createSession('admin')).resolves.toMatchObject({ role: 'admin' });
  });

  it('ensureSession is idempotent when a session already exists', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { session_id: 's', csrf_token: 'csrf', role: 'admin', expires_at: '' },
        { setCookie: 'hearth_session=c; Path=/' },
      ),
    );
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    const before = fetchMock.mock.calls.length;
    await api.ensureSession();
    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('HearthApi request headers', () => {
  it('POST /v1/interpret sends x-hearth-csrf', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      n++;
      if (n === 1) {
        // session create
        return jsonResponse(
          { session_id: 's', csrf_token: 'csrf-secret', role: 'admin', expires_at: '' },
          { setCookie: 'hearth_session=cookieval; Path=/; HttpOnly' },
        );
      }
      // interpret
      if (init?.method === 'POST') {
        // The browser sends the HttpOnly cookie with credentials: include.
      }
      return jsonResponse({
        request_id: 'r1',
        decision: { outcome: 'ready_for_contract', proposal: {} },
        actor: { actor_id: 'a', role: 'admin' },
      });
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await api.interpret('turn on the lamp', 'req-1');

    const interpretCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = interpretCall[1].headers as Headers;
    expect(headers.get('x-hearth-csrf')).toBe('csrf-secret');
    expect(headers.get('cookie')).toBeNull();
    expect(interpretCall[1].credentials).toBe('include');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('POST /v1/devices/:id/control sends only desired state with CSRF', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      n++;
      return n === 1
        ? jsonResponse({ session_id: 's1', csrf_token: 'csrf-admin', role: 'admin', expires_at: '' })
        : jsonResponse({ contract_id: 'c1', receipt: { aggregate: 'confirmed' } });
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await api.controlDevice('ha:light.kitchen', true);

    const controlCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = controlCall[1].headers as Headers;
    expect(controlCall[0]).toBe('/v1/devices/ha%3Alight.kitchen/control');
    expect(JSON.parse(String(controlCall[1].body))).toEqual({ desired_values: { on: true } });
    expect(headers.get('x-hearth-csrf')).toBe('csrf-admin');
  });

  it('GET /v1/devices does NOT send x-hearth-csrf (safe method)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      n++;
      if (n === 1) {
        return jsonResponse(
          { session_id: 's', csrf_token: 'csrf', role: 'admin', expires_at: '' },
          { setCookie: 'hearth_session=c; Path=/' },
        );
      }
      return jsonResponse({ devices: [], rooms: [], actor: {} });
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await api.listDevices();

    const listCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const headers = listCall[1].headers as Headers;
    expect(headers.get('x-hearth-csrf')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(listCall[1].credentials).toBe('include');
  });

  it('creates and pauses a routine with CSRF and no client authority fields', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      n++;
      if (n === 1) return jsonResponse({ session_id: 's', csrf_token: 'csrf', role: 'admin', expires_at: '' });
      if (n === 2) return jsonResponse({ routine: { routine_id: 'r1' } }, { status: 201 });
      return jsonResponse({ routine_id: 'r1', enabled: false });
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await api.createRoutine({ name: 'Wake up', time_local: '07:30', time_zone: 'America/Chicago', target_canonical_id: 'ha:light.lamp', on: true });
    await api.setRoutineEnabled('r1', false);

    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const patchCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(JSON.parse(String(createCall[1].body))).toEqual({ name: 'Wake up', time_local: '07:30', time_zone: 'America/Chicago', target_canonical_id: 'ha:light.lamp', on: true });
    expect((createCall[1].headers as Headers).get('x-hearth-csrf')).toBe('csrf');
    expect(patchCall[0]).toBe('/v1/routines/r1');
    expect(patchCall[1].method).toBe('PATCH');
    expect(JSON.parse(String(patchCall[1].body))).toEqual({ enabled: false });
    expect((patchCall[1].headers as Headers).get('x-hearth-csrf')).toBe('csrf');
  });

  it('renews an expired admin session once and retries the blocked read', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      n++;
      if (n === 1) return jsonResponse({ session_id: 'old', csrf_token: 'old-csrf', role: 'admin', expires_at: '' });
      if (n === 2) return jsonResponse({ error: { code: 'no_session' } }, { status: 401 });
      if (n === 3) return jsonResponse({ session_id: 'new', csrf_token: 'new-csrf', role: 'admin', expires_at: '' });
      return jsonResponse({ devices: [], rooms: [], actor: { actor_id: 'admin', role: 'admin' } });
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await expect(api.listDevices()).resolves.toMatchObject({ devices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const retry = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect((retry[1].headers as Headers).get('x-hearth-csrf')).toBeNull();
    expect(sessionStorage.getItem('hearth.csrf_token')).toBe('new-csrf');
  });

  it('surfaces a non-2xx as an ApiError with status', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      n++;
      if (n === 1) {
        return jsonResponse(
          { session_id: 's', csrf_token: 'csrf', role: 'admin', expires_at: '' },
          { setCookie: 'hearth_session=c; Path=/' },
        );
      }
      return jsonResponse(
        { error: { code: 'no_session', message: 'no active session' } },
        { status: 401 },
      );
    });
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');
    await expect(api.listDevices()).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });
  });
});
