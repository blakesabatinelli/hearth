import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, createSession, csrfHeaders, type TestControl } from './fixtures.js';

let tc: TestControl;
beforeEach(async () => { tc = await buildTestControl(); });
afterEach(async () => { await tc.tearDown(); });

describe('routine and history API', () => {
  it('creates routines with server-derived role and exact authorized target, then pauses and removes them', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((device) => device.friendly_name === 'Living Room Lamp')!;
    const session = await createSession(tc.app, 'admin');
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const timeParts = formatter.formatToParts(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const timeLocal = `${timeParts.find((part) => part.type === 'hour')?.value}:${timeParts.find((part) => part.type === 'minute')?.value}`;
    const created = await tc.app.inject({
      method: 'POST',
      url: '/v1/routines',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: {
        name: 'Evening lamp',
        time_local: timeLocal,
        time_zone: 'America/Chicago',
        target_canonical_id: lamp.canonical_id,
        on: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const routine = (created.json() as { routine: { routine_id: string; cron: string; role?: string; target_phrases: string[] } }).routine;
    expect(routine.role).toBeUndefined();
    expect(routine.target_phrases).toEqual([lamp.canonical_id]);
    expect(tc.schedule_store.listRoutines()[0]).toMatchObject({
      routine_id: routine.routine_id,
      role: 'admin',
      time_zone: 'America/Chicago',
      enabled: true,
    });

    const forged = await tc.app.inject({
      method: 'POST',
      url: '/v1/routines',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { name: 'Forged', time_local: timeLocal, time_zone: 'America/Chicago', target_canonical_id: lamp.canonical_id, on: false, role: 'service', actor_id: 'forged' },
    });
    expect(forged.statusCode).toBe(400);
    expect(tc.schedule_store.listRoutines()).toHaveLength(1);

    const listed = await tc.app.inject({ method: 'GET', url: '/v1/routines', headers: { cookie: session.cookie } });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { routines: Array<{ routine_id: string; enabled: boolean }> }).routines[0]).toMatchObject({ routine_id: routine.routine_id, enabled: true });

    const paused = await tc.app.inject({
      method: 'PATCH',
      url: `/v1/routines/${routine.routine_id}`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(tc.schedule_store.listRoutines()[0]?.enabled).toBe(false);

    const removed = await tc.app.inject({
      method: 'DELETE',
      url: `/v1/routines/${routine.routine_id}`,
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
    });
    expect(removed.statusCode).toBe(200);
    expect(tc.schedule_store.listRoutines()).toEqual([]);
  });

  it('requires a CSRF token and exact live allowlist membership when scheduling', async () => {
    const lamp = tc.hearth_registry.snapshot().devices.find((device) => device.friendly_name === 'Living Room Lamp')!;
    await tc.tearDown();
    tc = await buildTestControl({ live_ha_actuation_allowlist: new Set() });
    const session = await createSession(tc.app, 'admin');
    const fields = {
      name: 'Blocked', time_local: '23:59', time_zone: 'UTC', target_canonical_id: lamp.canonical_id, on: true,
    };
    const noCsrf = await tc.app.inject({ method: 'POST', url: '/v1/routines', headers: { cookie: session.cookie }, payload: fields });
    expect(noCsrf.statusCode).toBe(403);
    const blocked = await tc.app.inject({
      method: 'POST', url: '/v1/routines',
      headers: { cookie: session.cookie, ...csrfHeaders(session.csrf) },
      payload: fields,
    });
    expect(blocked.statusCode).toBe(403);
    expect(tc.schedule_store.listRoutines()).toHaveLength(0);
  });

  it('lists recent receipts only to an active session and bounds the requested page size', async () => {
    const noSession = await tc.app.inject({ method: 'GET', url: '/v1/receipts' });
    expect(noSession.statusCode).toBe(401);
    const session = await createSession(tc.app, 'admin');
    expect((await tc.app.inject({ method: 'GET', url: '/v1/receipts', headers: { cookie: session.cookie } })).statusCode).toBe(200);
    expect((await tc.app.inject({ method: 'GET', url: '/v1/receipts?limit=101', headers: { cookie: session.cookie } })).statusCode).toBe(400);
  });
});
