/**
 * Session + CSRF smoke tests.
 *
 * Covers AC-12 (service boots) and AC-14 (session + CSRF).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, createSession, csrfHeaders, type TestControl } from './fixtures.js';

let tc: TestControl;

beforeEach(async () => {
  tc = await buildTestControl();
});

afterEach(async () => {
  await tc.tearDown();
});

describe('AC-12 service boots', () => {
  it('GET /healthz returns 200 with status ok', async () => {
    const res = await tc.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 with device count', async () => {
    const res = await tc.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; device_count: number };
    expect(body.status).toBe('ready');
    expect(body.device_count).toBeGreaterThan(0);
  });
});

describe('AC-14 session + CSRF', () => {
  it('POST /v1/sessions creates a session, sets a cookie, returns csrf_token', async () => {
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string; csrf_token: string; role: string };
    expect(body.role).toBe('admin');
    expect(typeof body.session_id).toBe('string');
    expect(typeof body.csrf_token).toBe('string');
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    expect(cookieStr).toContain('hearth_session=');
  });

  it('rejects an unknown role with 400', async () => {
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { role: 'wizard' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_role');
  });

  it('a state-changing route without a session returns 401', async () => {
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      payload: { utterance: 'turn on the lamp' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('no_session');
  });

  it('a state-changing route with a session but no CSRF returns 403', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      headers: { cookie: sess.cookie },
      payload: { utterance: 'turn on the lamp' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('csrf_invalid');
  });

  it('a state-changing route with valid session + CSRF is accepted', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: { utterance: 'turn on the lamp' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('tampered cookie fails verify (no session returned)', async () => {
    const sess = await createSession(tc.app);
    // Replace last char of the cookie value to invalidate the HMAC
    const tampered = sess.cookie.slice(0, -1) + (sess.cookie.endsWith('A') ? 'B' : 'A');
    const res = await tc.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: { cookie: tampered },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/csrf returns the session csrf token', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'GET',
      url: '/v1/csrf',
      headers: { cookie: sess.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { csrf_token: string };
    expect(body.csrf_token).toBe(sess.csrf);
  });

  it('DELETE /v1/sessions/:id destroys the session', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sess.session_id}`,
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
    });
    expect(res.statusCode).toBe(200);
    const after = await tc.app.inject({
      method: 'GET',
      url: '/v1/csrf',
      headers: { cookie: sess.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('AC-15 server-derived principal fields', () => {
  it('actor on the receipt reflects the session role, not the request body', async () => {
    const sess = await createSession(tc.app, 'member');
    // Build a proposal manually and submit. The request body MUST NOT carry
    // actor_id or role; if it does, the interpreter rejects with 400.
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: {
        proposal: {
          request_id: 'req-1',
          intent_family: 'set-state',
          target_phrases: ['lamp'],
          exclusions: [],
          desired_values: { on: true },
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'turn-on' },
        },
      },
    });
    // Member role is allowed on the lamp (lamp allows admin+member).
    expect(res.statusCode).toBe(200);
    const body = res.json() as { receipt: { actor: { role: string; actor_id: string } } };
    expect(body.receipt.actor.role).toBe('member');
    // The actor_id was server-derived (NOT 'member-req-1' as the request would do).
    expect(body.receipt.actor.actor_id).not.toBe('req-1');
  });

  it('forbidden request fields (actor_id, role) cause 400', async () => {
    const sess = await createSession(tc.app);
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      headers: { cookie: sess.cookie, ...csrfHeaders(sess.csrf) },
      payload: {
        utterance: 'turn on the lamp',
        payload: {
          actor_id: 'evil-actor',
          role: 'admin',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_field');
  });
});