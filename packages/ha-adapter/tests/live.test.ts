/**
 * LiveHAAdapter unit tests.
 *
 * The adapter talks to a real Home Assistant instance. These tests mock
 * `fetch` so the unit suite runs without a live HA.
 *
 * The WebSocket path is exercised separately in apps/control/tests
 * because the harness uses the node `WebSocket` constructor; here we
 * stub dispatch + list + getState against a fake fetch that returns
 * canned HA JSON.
 */

import { describe, it, expect } from 'vitest';
import { LiveHAAdapter } from '../src/index.js';

type FetchResponse = {
  ok: boolean;
  status: number;
  body?: unknown;
  text_body?: string;
};

function makeMockFetch(responses: FetchResponse[]): typeof fetch {
  let i = 0;
  return (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
    const r = responses[i] ?? responses[responses.length - 1]!;
    i += 1;
    void input;
    return new Response(
      r.text_body ?? (r.body !== undefined ? JSON.stringify(r.body) : ''),
      { status: r.status, statusText: r.ok ? 'OK' : 'ERR' },
    );
  }) as typeof fetch;
}

const HA_STATES = [
  {
    entity_id: 'light.living_room_lamp',
    state: 'off',
    attributes: { friendly_name: 'Living Room Lamp', brightness: 0 },
    last_changed: '2026-09-25T00:00:00Z',
    last_updated: '2026-09-25T00:00:00Z',
  },
  {
    entity_id: 'light.kitchen_lights',
    state: 'on',
    attributes: { friendly_name: 'Kitchen Lights', brightness: 200 },
    last_changed: '2026-09-25T00:00:00Z',
    last_updated: '2026-09-25T00:00:00Z',
  },
  {
    entity_id: 'sensor.temp',
    state: '21',
    attributes: { friendly_name: 'Temperature', unit_of_measurement: 'C' },
    last_changed: '2026-09-25T00:00:00Z',
    last_updated: '2026-09-25T00:00:00Z',
  },
];

const HA_AREAS = [
  { area_id: 'living_room', name: 'Living Room' },
  { area_id: 'kitchen', name: 'Kitchen' },
];

const HA_REGISTRY = {
  entities: [
    { entity_id: 'light.living_room_lamp', area_id: 'living_room' },
    { entity_id: 'light.kitchen_lights', area_id: 'kitchen' },
    { entity_id: 'sensor.temp', area_id: null },
  ],
};

describe('LiveHAAdapter', () => {
  it('probe() throws on a non-2xx response', async () => {
    const f = makeMockFetch([{ ok: false, status: 401, text_body: 'auth' }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'bad', fetch_impl: f });
    await expect(a.probe()).rejects.toThrow();
  });

  it('probe() throws on auth_invalid in the body', async () => {
    const f = makeMockFetch([{ ok: true, status: 200, body: { message: 'auth_invalid' } }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'bad', fetch_impl: f });
    await expect(a.probe()).rejects.toThrow(/auth_invalid/);
  });

  it('listDevices() returns only actuator entities, namespaced as ha:<entity_id>', async () => {
    const f = makeMockFetch([
      { ok: true, status: 200, body: HA_STATES },
      { ok: true, status: 200, body: HA_AREAS },
      { ok: true, status: 200, body: HA_REGISTRY },
    ]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const devices = await a.listDevices();
    // Two actuator lights; sensor.temp is filtered out.
    expect(devices.length).toBe(2);
    const ids = devices.map((d) => d.canonical_id);
    expect(ids).toContain('ha:light.living_room_lamp');
    expect(ids).toContain('ha:light.kitchen_lights');
    // load_type is mapped from HA domain to Hearth LoadType.
    for (const d of devices) {
      expect(d.load_type).toBe('light');
      expect(d.provider_ids.length).toBe(1);
      expect(d.provider_ids[0]!.kind).toBe('ha');
    }
  });

  it('listRooms() returns rooms with the right device_ids', async () => {
    const f = makeMockFetch([
      { ok: true, status: 200, body: HA_AREAS },
      { ok: true, status: 200, body: HA_REGISTRY },
      { ok: true, status: 200, body: HA_STATES },
    ]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const rooms = await a.listRooms();
    expect(rooms.length).toBe(2);
    const by_name = new Map(rooms.map((r) => [r.name, r]));
    expect(by_name.get('Living Room')?.device_ids).toEqual(['ha:light.living_room_lamp']);
    expect(by_name.get('Kitchen')?.device_ids).toEqual(['ha:light.kitchen_lights']);
  });

  it('getState() returns the on/brightness values, with state_version > 0', async () => {
    const f = makeMockFetch([
      {
        ok: true, status: 200,
        body: {
          entity_id: 'light.living_room_lamp',
          state: 'on',
          attributes: { friendly_name: 'Living Room Lamp', brightness: 200 },
          last_changed: '2026-09-25T00:00:00Z',
          last_updated: '2026-09-25T00:00:00Z',
        },
      },
    ]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const obs = await a.getState('ha:light.living_room_lamp' as never);
    expect(obs.canonical_id).toBe('ha:light.living_room_lamp');
    expect(obs.values['on']).toBe(true);
    // 200/255 * 100 ~= 78
    expect(obs.values['brightness']).toBeGreaterThan(50);
    expect(obs.source).toBe('fresh-poll');
    expect(obs.state_version).toBeGreaterThanOrEqual(1);
  });

  it('dispatch() POSTs the right service for turn_on with brightness_pct', async () => {
    const captured: { url: string; method: string; body: unknown }[] = [];
    const f = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      captured.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      // First call: /api/ (probe isn't called here, just dispatch)
      if (url.endsWith('/api/services/light/turn_on')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('null', { status: 404 });
    }) as typeof fetch;
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const ack = await a.dispatch(
      {
        canonical_id: 'ha:light.living_room_lamp' as never,
        load_type: 'light',
        route: 'ha-only',
        state_version: 1,
      },
      { on: true, brightness: 75 },
    );
    expect(ack.kind).toBe('sent');
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toContain('/api/services/light/turn_on');
    expect(captured[0]!.method).toBe('POST');
    const body = captured[0]!.body as { entity_id: string; brightness_pct: number };
    expect(body.entity_id).toBe('light.living_room_lamp');
    expect(body.brightness_pct).toBe(75);
  });

  it('dispatch() with on:false uses turn_off service', async () => {
    const captured: string[] = [];
    const f = (async (input: string | URL): Promise<Response> => {
      captured.push(typeof input === 'string' ? input : (input as URL).toString());
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    await a.dispatch(
      {
        canonical_id: 'ha:light.living_room_lamp' as never,
        load_type: 'light',
        route: 'ha-only',
        state_version: 1,
      },
      { on: false },
    );
    expect(captured[0]).toContain('/api/services/light/turn_off');
  });

  it('dispatch() returns rejected on non-2xx', async () => {
    const f = makeMockFetch([{ ok: false, status: 500, text_body: 'kaboom' }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const ack = await a.dispatch(
      {
        canonical_id: 'ha:light.living_room_lamp' as never,
        load_type: 'light',
        route: 'ha-only',
        state_version: 1,
      },
      { on: true },
    );
    expect(ack.kind).toBe('rejected');
  });

  it('listRooms() returns empty list when /api/areas is 404', async () => {
    const f = makeMockFetch([
      { ok: false, status: 404, text_body: 'no areas' },
      { ok: true, status: 200, body: HA_REGISTRY },
      { ok: true, status: 200, body: HA_STATES },
    ]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const rooms = await a.listRooms();
    expect(rooms).toEqual([]);
  });
});
