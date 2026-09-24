/**
 * api.ts unit tests.
 *
 * Covers:
 *  - parseSetCookieForName strips metadata (Path, HttpOnly, SameSite, Max-Age)
 *  - createSession captures cookie + CSRF in sessionStorage
 *  - POST /v1/interpret sends x-hearth-csrf header (state-changing)
 *  - GET /v1/devices does NOT send x-hearth-csrf (safe method)
 *  - non-2xx responses surface as ApiError with status
 *  - ensureSession is idempotent
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  HearthApi,
  ApiError,
  parseSetCookieForName,
} from '../src/api';

function jsonResponse(body: unknown, init: { status?: number; setCookie?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.setCookie) headers['set-cookie'] = init.setCookie;
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('parseSetCookieForName', () => {
  it('returns name=value when metadata is present', () => {
    const got = parseSetCookieForName(
      'hearth_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800',
      'hearth_session',
    );
    expect(got).toBe('hearth_session=abc123');
  });

  it('returns null when the cookie is missing', () => {
    expect(parseSetCookieForName('other=1; Path=/', 'hearth_session')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseSetCookieForName(null, 'hearth_session')).toBeNull();
  });

  it('handles a bare value with no metadata', () => {
    expect(parseSetCookieForName('hearth_session=xyz', 'hearth_session')).toBe(
      'hearth_session=xyz',
    );
  });
});

describe('HearthApi.createSession', () => {
  it('captures the cookie and CSRF token in sessionStorage', async () => {
    const cookieValue = 'hearth_session=abc123; Path=/; HttpOnly; SameSite=Lax';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          session_id: 'sess-1',
          csrf_token: 'csrf-1',
          role: 'admin',
          expires_at: '2027-01-01T00:00:00.000Z',
        },
        { setCookie: cookieValue },
      ),
    );
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createSession('admin');

    expect(api.getCookie()).toBe('hearth_session=abc123');
    expect(api.getCsrf()).toBe('csrf-1');
    expect(api.getSessionId()).toBe('sess-1');
    expect(sessionStorage.getItem('hearth.cookie')).toContain('hearth_session=');
    expect(sessionStorage.getItem('hearth.csrf_token')).toBe('csrf-1');
    expect(sessionStorage.getItem('hearth.session_id')).toBe('sess-1');
  });

  it('throws ApiError when the Set-Cookie header is missing', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ session_id: 'x', csrf_token: 'y', role: 'admin', expires_at: '' }),
    );
    const api = new HearthApi({ fetchImpl: fetchMock as unknown as typeof fetch });
    await expect(api.createSession('admin')).rejects.toBeInstanceOf(ApiError);
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
        // Assert that the headers carry CSRF + cookie. We can't reach the
        // captured init from outside, so instead read fetchMock.mock.calls.
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
    expect(headers.get('cookie')).toContain('hearth_session=cookieval');
    expect(headers.get('content-type')).toBe('application/json');
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
    expect(headers.get('cookie')).toContain('hearth_session=c');
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
