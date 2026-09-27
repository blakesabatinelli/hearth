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
  areas: HA_AREAS,
  devices: [{ id: 'ha-device-living-room', area_id: 'living_room', name: 'Living Room Bridge', manufacturer: 'Example', model: 'Bridge 2' }],
  entities: [
    { entity_id: 'light.living_room_lamp', area_id: 'living_room', device_id: 'ha-device-living-room', unique_id: 'unique-lamp', platform: 'hue', entity_category: null },
    { entity_id: 'light.kitchen_lights', area_id: 'kitchen' },
    { entity_id: 'sensor.temp', area_id: null },
  ],
};

function makeMockWebSocket(snapshot = HA_REGISTRY): (url: string) => WebSocket {
  return (_url: string): WebSocket => {
    const listeners = new Map<string, Array<(event: MessageEvent | Event) => void>>();
    const socketState = { readyState: 1 };
    const emit = (type: string, event: MessageEvent | Event): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const socket = {
      get readyState() { return socketState.readyState; },
      addEventListener(type: string, listener: (event: MessageEvent | Event) => void) {
        const registered = listeners.get(type) ?? [];
        registered.push(listener);
        listeners.set(type, registered);
      },
      removeEventListener() {},
      close() { socketState.readyState = 3; },
      send(raw: string) {
        const message = JSON.parse(raw) as { type: string; id?: number };
        if (message.type === 'auth') {
          queueMicrotask(() => emit('message', { data: JSON.stringify({ type: 'auth_ok' }) } as MessageEvent));
          return;
        }
        const result = message.type === 'config/area_registry/list'
          ? snapshot.areas
          : message.type === 'config/device_registry/list'
            ? snapshot.devices
            : snapshot.entities;
        queueMicrotask(() => emit('message', {
          data: JSON.stringify({ id: message.id, type: 'result', success: true, result }),
        } as MessageEvent));
      },
    } as unknown as WebSocket;
    queueMicrotask(() => emit('message', { data: JSON.stringify({ type: 'auth_required' }) } as MessageEvent));
    return socket;
  };
}

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
    const f = makeMockFetch([{ ok: true, status: 200, body: HA_STATES }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f, websocket_factory: makeMockWebSocket() });
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
      expect(d.allowed_actors).toEqual([]);
    }
  });

  it('retains the HA physical device and integration metadata for local review', async () => {
    const f = makeMockFetch([{ ok: true, status: 200, body: HA_STATES }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f, websocket_factory: makeMockWebSocket() });
    const device = (await a.listDevices()).find((item) => item.canonical_id === 'ha:light.living_room_lamp');
    expect(device?.provider_ids[0]).toMatchObject({
      kind: 'ha',
      entity_id: 'light.living_room_lamp',
      device_id: 'ha-device-living-room',
      unique_id: 'unique-lamp',
      platform: 'hue',
      device_name: 'Living Room Bridge',
      manufacturer: 'Example',
      model: 'Bridge 2',
    });
  });

  it('allows executor dispatch only for exact entity IDs in the pilot allowlist', async () => {
    const f = makeMockFetch([{ ok: true, status: 200, body: HA_STATES }]);
    const a = new LiveHAAdapter({
      base_url: 'http://127.0.0.1:8123',
      token: 'good',
      fetch_impl: f,
      actuation_allowlist: new Set(['light.living_room_lamp']),
      websocket_factory: makeMockWebSocket(),
    });
    const devices = await a.listDevices();
    const living_room_lamp = devices.find((d) => d.canonical_id === 'ha:light.living_room_lamp');
    const kitchen_lights = devices.find((d) => d.canonical_id === 'ha:light.kitchen_lights');
    expect(living_room_lamp?.allowed_actors).toEqual(['admin', 'member', 'wall-tablet']);
    expect(kitchen_lights?.allowed_actors).toEqual([]);
  });

  it('listRooms() returns rooms with the right device_ids', async () => {
    const f = makeMockFetch([{ ok: true, status: 200, body: HA_STATES }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f, websocket_factory: makeMockWebSocket() });
    const rooms = await a.listRooms();
    expect(rooms.length).toBe(2);
    const by_name = new Map(rooms.map((r) => [r.name, r]));
    expect(by_name.get('Living Room')?.device_ids).toEqual(['ha:light.living_room_lamp']);
    expect(by_name.get('Kitchen')?.device_ids).toEqual(['ha:light.kitchen_lights']);
  });

  it('subscribes to state_changed and forwards fresh matching observations', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const listeners = new Map<string, Array<(event: MessageEvent | Event) => void>>();
    let ready_state = 0;
    const emit = (type: string, event: MessageEvent | Event): void => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    const socket = {
      get readyState() { return ready_state; },
      addEventListener(type: string, listener: (event: MessageEvent | Event) => void) {
        const existing = listeners.get(type) ?? [];
        existing.push(listener);
        listeners.set(type, existing);
        if (type === 'open') {
          queueMicrotask(() => {
            ready_state = 1;
            emit('open', {} as Event);
          });
        }
      },
      removeEventListener() {},
      close() { ready_state = 3; },
      send(raw: string) {
        const message = JSON.parse(raw) as Record<string, unknown>;
        sent.push(message);
        if (message['type'] === 'auth') {
          queueMicrotask(() => emit('message', { data: JSON.stringify({ type: 'auth_ok' }) } as MessageEvent));
        }
      },
    } as unknown as WebSocket;
    const a = new LiveHAAdapter({
      base_url: 'http://127.0.0.1:8123',
      token: 'good',
      fetch_impl: makeMockFetch([]),
      websocket_factory: () => socket,
    });
    const received: Array<{ values: Readonly<Record<string, unknown>> }> = [];
    a.subscribe(['ha:light.living_room_lamp' as never], (obs) => received.push(obs));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toContainEqual({ id: 1, type: 'subscribe_events', event_type: 'state_changed' });
    emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: {
          entity_id: 'light.living_room_lamp',
          new_state: {
            entity_id: 'light.living_room_lamp',
            state: 'on',
            attributes: { friendly_name: 'Living Room Lamp', brightness: 200 },
            last_changed: '2020-01-01T00:00:00Z',
            last_updated: '2020-01-01T00:00:00Z',
          },
        },
      }),
    } as MessageEvent);

    expect(received).toHaveLength(1);
    expect(received[0]?.values['on']).toBe(true);
    a.shutdown();
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

  it('uses the fresh poll time as observed_at when HA state has not changed recently', async () => {
    const f = makeMockFetch([{
      ok: true,
      status: 200,
      body: {
        entity_id: 'light.living_room_lamp',
        state: 'on',
        attributes: { friendly_name: 'Living Room Lamp', brightness: 200 },
        last_changed: '2020-01-01T00:00:00Z',
        last_updated: '2020-01-01T00:00:00Z',
      },
    }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });
    const before_poll = Date.now();

    const obs = await a.getState('ha:light.living_room_lamp' as never);

    const observed_at = Date.parse(obs.observed_at);
    expect(observed_at).toBeGreaterThanOrEqual(before_poll);
    expect(observed_at).toBeLessThanOrEqual(Date.now());
  });

  it('does not mark unchanged fresh polls as a stale state version', async () => {
    const f = makeMockFetch([{
      ok: true,
      status: 200,
      body: {
        entity_id: 'light.living_room_lamp',
        state: 'off',
        attributes: { friendly_name: 'Living Room Lamp', brightness: 0 },
        last_changed: '2026-09-25T00:00:00Z',
        last_updated: '2026-09-25T00:00:00Z',
      },
    }]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });

    const first = await a.getState('ha:light.living_room_lamp' as never);
    const second = await a.getState('ha:light.living_room_lamp' as never);

    expect(second.values).toEqual(first.values);
    expect(second.state_version).toBe(first.state_version);
  });

  it('advances state_version when a command-relevant HA value changes', async () => {
    const f = makeMockFetch([
      {
        ok: true,
        status: 200,
        body: {
          entity_id: 'light.living_room_lamp',
          state: 'off',
          attributes: { friendly_name: 'Living Room Lamp', brightness: 0 },
          last_changed: '2026-09-25T00:00:00Z',
          last_updated: '2026-09-25T00:00:00Z',
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          entity_id: 'light.living_room_lamp',
          state: 'on',
          attributes: { friendly_name: 'Living Room Lamp', brightness: 128 },
          last_changed: '2026-09-25T00:01:00Z',
          last_updated: '2026-09-25T00:01:00Z',
        },
      },
    ]);
    const a = new LiveHAAdapter({ base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f });

    const first = await a.getState('ha:light.living_room_lamp' as never);
    const second = await a.getState('ha:light.living_room_lamp' as never);

    expect(second.values).not.toEqual(first.values);
    expect(second.state_version).toBe(first.state_version + 1);
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

  it('listRooms() returns empty list when the HA registries have no areas', async () => {
    const f = makeMockFetch([{ ok: true, status: 200, body: [] }]);
    const empty_registry = { areas: [], devices: [], entities: [] };
    const a = new LiveHAAdapter({
      base_url: 'http://127.0.0.1:8123', token: 'good', fetch_impl: f,
      websocket_factory: makeMockWebSocket(empty_registry),
    });
    const rooms = await a.listRooms();
    expect(rooms).toEqual([]);
  });
});
