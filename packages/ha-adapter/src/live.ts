/**
 * LiveHAAdapter: real Home Assistant adapter.
 *
 * Implements the HomeAssistantAdapter contract against a real HA
 * instance reachable at `base_url` with a long-lived `token`.
 *
 * Surfaces:
 *   - REST: GET /api/states, GET /api/states/<entity_id>,
 *           POST /api/services/<domain>/<service>
 *   - WebSocket: registries and state_changed events via /api/websocket
 *
 * Notes:
 *   - Plan section 8: a state-changed event that arrives BEFORE the
 *     dispatch ack counts as the receipt's outcome; we do NOT poll for
 *     confirmation when a subscription is registered for the target.
 *   - Plan section 13 item 1: import areas, devices, entities,
 *     capabilities, availability, and state versions from HA.
 *   - State versions are tracked locally so contract stale-context
 *     checks compare against the most recent observation we have
 *     (either a subscribe event or a fresh poll).
 */

import type {
  CanonicalId,
  Capability,
  ContractTarget,
  DeviceRecord,
  DispatchAck,
  HomeAssistantAdapter,
  LoadType,
  ProviderId,
  Room,
  RoomId,
  StateHandler,
  StateObservation,
  UnsubscribeableSubscription,
} from '@hearth/contracts';

export type LiveHAOptions = {
  readonly base_url: string;
  readonly token: string;
  /**
   * Optional fetch override for tests; defaults to global fetch.
   */
  readonly fetch_impl?: typeof fetch;
  /** Exact HA entity IDs approved for executor dispatch. Empty by default. */
  readonly actuation_allowlist?: ReadonlySet<string>;
  /** Optional WebSocket override for Home Assistant registry discovery tests. */
  readonly websocket_factory?: (url: string) => WebSocket;
};

type HARawState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
};

type HARawArea = {
  area_id: string;
  name: string;
};

type HARawEntityRegistryEntry = {
  entity_id: string;
  area_id: string | null;
  device_id?: string | null;
  unique_id?: string;
  platform?: string;
  entity_category?: string | null;
};

type HARawDeviceRegistryEntry = {
  id: string;
  area_id: string | null;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
};

type HARegistrySnapshot = {
  readonly areas: HARawArea[];
  readonly entities: HARawEntityRegistryEntry[];
  readonly devices: HARawDeviceRegistryEntry[];
};

type Subscription = {
  readonly canonical_ids: Set<CanonicalId>;
  readonly handler: StateHandler;
  unsubscribe: () => void;
};

// HA domain -> Hearth LoadType mapping. Hearth's LoadType is narrow:
// 'light', 'unknown-switch', 'outlet', 'fan', 'blind', 'lock',
// 'media', 'other'. HA's domain names don't match 1:1, so the mapping
// is intentionally lossy: a 'switch.*' entity becomes
// 'unknown-switch' (NOT pre-classified as lighting, plan section 3),
// 'cover' becomes 'blind' (future scope), 'climate' and 'sensor'
// become 'other'.
const HA_LOAD_TYPE_MAP: Readonly<Record<string, LoadType>> = {
  light: 'light',
  switch: 'unknown-switch',
  fan: 'fan',
  cover: 'blind',
  climate: 'other',
  lock: 'lock',
  media_player: 'media',
  sensor: 'other',
  binary_sensor: 'other',
};

const HA_DOMAIN_TO_SERVICE: Readonly<Record<string, string>> = {
  light: 'turn_on',
  switch: 'turn_on',
  fan: 'turn_on',
  cover: 'close_cover',
  climate: 'set_temperature',
  lock: 'lock',
};

function sameStateValues(
  left: Readonly<Record<string, number | string | boolean>>,
  right: Readonly<Record<string, number | string | boolean>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]);
}

/**
 * Synthesize a canonical_id from an HA entity_id. The convention is
 * `ha:<entity_id>` so multiple HA installs can coexist if needed.
 */
function canonicalFromEntity(entity_id: string): CanonicalId {
  return `ha:${entity_id}` as CanonicalId;
}

function roomIdFromHA(area_id: string): RoomId {
  return `ha-area:${area_id}` as RoomId;
}

function inferCapabilities(entity_id: string, attrs: Record<string, unknown>): ReadonlyArray<Capability> {
  const caps: Capability[] = [];
  if (entity_id.startsWith('light.')) {
    caps.push('on-off');
    if ('brightness' in attrs || 'supported_color_modes' in attrs) caps.push('brightness');
    if ('color_temp' in attrs || 'color_mode' in attrs) caps.push('color-temperature');
    if ('rgb_color' in attrs || 'hs_color' in attrs) caps.push('color-rgb');
  } else if (entity_id.startsWith('switch.') || entity_id.startsWith('fan.') || entity_id.startsWith('cover.')) {
    caps.push('on-off');
  } else if (entity_id.startsWith('climate.')) {
    caps.push('on-off'); // set_hvac_mode is a kind of on-off
  }
  return caps;
}

function isActuatorEntity(entity_id: string): boolean {
  const domain = entity_id.split('.')[0] ?? '';
  // Sensors and binary sensors are intentionally NOT actuators even
  // though the LoadType map knows about them. They have no commands.
  if (domain === 'sensor' || domain === 'binary_sensor') return false;
  return Object.prototype.hasOwnProperty.call(HA_LOAD_TYPE_MAP, domain);
}

export class LiveHAAdapter implements HomeAssistantAdapter {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetch_impl: typeof fetch;
  private readonly actuation_allowlist: ReadonlySet<string>;
  private readonly websocket_factory: (url: string) => WebSocket;
  private readonly subs: Set<Subscription> = new Set();
  private ws: WebSocket | null = null;
  private ws_reconnect_attempt = 0;
  private ws_should_run = false;
  private readonly state_versions: Map<CanonicalId, number> = new Map();
  private readonly last_observed: Map<CanonicalId, string> = new Map();
  private readonly last_values: Map<CanonicalId, Readonly<Record<string, number | string | boolean>>> = new Map();
  private readonly area_cache: Map<string, HARawArea> = new Map();
  private readonly entity_to_area: Map<string, string> = new Map();
  private readonly entity_metadata: Map<string, Omit<Extract<ProviderId, { kind: 'ha' }>, 'kind' | 'entity_id'>> = new Map();

  constructor(opts: LiveHAOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetch_impl = opts.fetch_impl ?? fetch;
    this.actuation_allowlist = opts.actuation_allowlist ?? new Set();
    this.websocket_factory = opts.websocket_factory ?? ((url) => new WebSocket(url));
  }

  /**
   * Probe the connection by hitting /api/ with the token. Throws on
   * non-2xx, network errors, or HA's own "auth_invalid" response.
   * Used by apps/control/src/main.ts to fail closed before binding.
   */
  async probe(): Promise<void> {
    const res = await this.fetch_impl(`${this.base_url}/api/`, {
      headers: this.auth_headers(),
    });
    if (!res.ok) {
      throw new Error(`HA probe ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { message?: string };
    if (body.message && /auth/i.test(body.message)) {
      throw new Error(`HA auth_invalid: ${body.message}`);
    }
  }

  private auth_headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async listDevices(): Promise<ReadonlyArray<DeviceRecord>> {
    const [states, registry] = await Promise.all([
      this.fetch_states(),
      this.fetch_registry_snapshot().catch(() => null),
    ]);
    this.apply_registry_snapshot(registry);

    const devices: DeviceRecord[] = [];
    for (const s of states) {
      if (!isActuatorEntity(s.entity_id)) continue;
      const domain = s.entity_id.split('.')[0] ?? '';
      const load_type = HA_LOAD_TYPE_MAP[domain];
      if (!load_type) continue;

      const friendly_name =
        typeof s.attributes['friendly_name'] === 'string'
          ? s.attributes['friendly_name']
          : s.entity_id;

      const caps = inferCapabilities(s.entity_id, s.attributes);
      const area_id = this.entity_to_area.get(s.entity_id);
      const metadata = this.entity_metadata.get(s.entity_id);
      const provider_id: ProviderId = {
        kind: 'ha',
        entity_id: s.entity_id,
        ...(metadata ?? {}),
      };

      const canonical_id = canonicalFromEntity(s.entity_id);
      devices.push({
        canonical_id,
        friendly_name,
        load_type,
        capabilities: caps,
        aliases: [s.entity_id, friendly_name].filter((a, i, arr) => arr.indexOf(a) === i),
        provider_ids: [provider_id],
        room_id: area_id ? roomIdFromHA(area_id) : null,
        allowed_actors: this.actuation_allowlist.has(s.entity_id)
          ? ['admin', 'member', 'wall-tablet'] as const
          : [],
        route_preference: 'ha-only',
        version: 1,
      });
    }

    return devices;
  }

  async listRooms(): Promise<ReadonlyArray<Room>> {
    const registry = await this.fetch_registry_snapshot().catch(() => null);
    this.apply_registry_snapshot(registry);
    const room_entity: Map<string, Set<CanonicalId>> = new Map();
    const states = await this.fetch_states();
    for (const s of states) {
      if (!isActuatorEntity(s.entity_id)) continue;
      const area_id = this.entity_to_area.get(s.entity_id);
      if (!area_id) continue;
      const cid = canonicalFromEntity(s.entity_id);
      const set = room_entity.get(area_id) ?? new Set<CanonicalId>();
      set.add(cid);
      room_entity.set(area_id, set);
    }
    const rooms: Room[] = [];
    // Devices with no assigned area fall into a synthetic room keyed by
    // null so the UI can render them in an "Unassigned" bucket without
    // dropping them entirely. listDevices() also surfaces them.
    const unassigned: Set<CanonicalId> = new Set();
    for (const s of states) {
      if (!isActuatorEntity(s.entity_id)) continue;
      const area_id = this.entity_to_area.get(s.entity_id);
      if (area_id) continue;
      unassigned.add(canonicalFromEntity(s.entity_id));
    }
    for (const a of this.area_cache.values()) {
      const ids = Array.from(room_entity.get(a.area_id) ?? new Set<CanonicalId>());
      rooms.push({
        room_id: roomIdFromHA(a.area_id),
        name: a.name,
        device_ids: ids,
      });
    }
    if (unassigned.size > 0) {
      rooms.push({
        room_id: roomIdFromHA('unassigned'),
        name: 'Unassigned',
        device_ids: Array.from(unassigned),
      });
    }
    return rooms;
  }

  async getState(canonical_id: CanonicalId): Promise<StateObservation> {
    const entity_id = this.entityFromCanonical(canonical_id);
    const res = await this.fetch_impl(`${this.base_url}/api/states/${encodeURIComponent(entity_id)}`, {
      headers: this.auth_headers(),
    });
    if (!res.ok) {
      throw new Error(`HA getState ${entity_id}: ${res.status}`);
    }
    const s = (await res.json()) as HARawState;
    const obs = this.observationFromHA(s);
    this.state_versions.set(canonical_id, obs.state_version);
    this.last_observed.set(canonical_id, obs.observed_at);
    this.last_values.set(canonical_id, obs.values);
    return obs;
  }

  async dispatch(
    target: ContractTarget,
    desired_values: Readonly<Record<string, number | string | boolean>>,
  ): Promise<DispatchAck> {
    const entity_id = this.entityFromCanonical(target.canonical_id);
    const domain = entity_id.split('.')[0] ?? '';
    const service = this.serviceForDesired(domain, desired_values);
    const service_data = this.serviceDataForDesired(domain, desired_values, entity_id);

    const res = await this.fetch_impl(
      `${this.base_url}/api/services/${domain}/${service}`,
      {
        method: 'POST',
        headers: this.auth_headers(),
        body: JSON.stringify(service_data),
      },
    );

    if (!res.ok) {
      return {
        kind: 'rejected',
        reason: `HA dispatch ${domain}.${service} returned ${res.status}: ${await res.text()}`,
      };
    }

    // Bump local state_version optimistically. The receipt's
    // evidence watcher will reconcile against a subsequent
    // state_changed event (if subscribed) or a fresh poll.
    const prev_version = this.state_versions.get(target.canonical_id) ?? 1;
    const next_version = prev_version + 1;
    const observed_at = new Date().toISOString();
    this.state_versions.set(target.canonical_id, next_version);
    this.last_observed.set(target.canonical_id, observed_at);
    this.last_values.set(target.canonical_id, desired_values);

    // If anyone is subscribed to this canonical_id, they will receive
    // the state-changed event from the WebSocket path; the optimistic
    // local bump is enough for contract stale-context purposes.
    return {
      kind: 'sent',
      provider: 'ha',
      echoed_at: observed_at,
    };
  }

  subscribe(
    canonical_ids: ReadonlyArray<CanonicalId>,
    handler: StateHandler,
  ): UnsubscribeableSubscription {
    const sub: Subscription = {
      canonical_ids: new Set(canonical_ids),
      handler,
      unsubscribe: () => { this.subs.delete(sub); },
    };
    this.subs.add(sub);
    void this.ensureWebSocket();
    return { unsubscribe: sub.unsubscribe };
  }

  // ---- private helpers ----------------------------------------------------

  private entityFromCanonical(canonical_id: CanonicalId): string {
    // canonical_id is `ha:<entity_id>`; strip the prefix.
    const raw = canonical_id as unknown as string;
    const idx = raw.indexOf(':');
    if (idx < 0) throw new Error(`LiveHAAdapter: canonical_id is not HA-namespaced: ${raw}`);
    return raw.slice(idx + 1);
  }

  private observationFromHA(s: HARawState): StateObservation {
    const values: Record<string, number | string | boolean> = {};
    if (s.state === 'on' || s.state === 'off') values['on'] = s.state === 'on';
    const brightness = s.attributes['brightness'];
    if (typeof brightness === 'number') {
      values['brightness'] = Math.round((brightness / 255) * 100);
    }
    const color_temp = s.attributes['color_temp'];
    if (typeof color_temp === 'number') {
      values['color_temperature_kelvin'] = color_temp;
    }
    const rgb_color = s.attributes['rgb_color'];
    if (Array.isArray(rgb_color) && rgb_color.length === 3) {
      const [r, g, b] = rgb_color as [number, number, number];
      values['color_rgb'] = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    }
    // This timestamp describes when Hearth observed the state, not when HA
    // last saw a state change. An unchanged state is still freshly observed
    // by this REST poll and can satisfy an idempotent command safely.
    const observed_at = new Date().toISOString();
    const canonical_id = canonicalFromEntity(s.entity_id);
    const previous_values = this.last_values.get(canonical_id);
    const previous_version = this.state_versions.get(canonical_id) ?? 1;
    // Fresh polls alone do not make a contract stale. Advance the local
    // version only when a target's command-relevant state actually changed.
    const state_version = previous_values === undefined
      ? previous_version
      : sameStateValues(previous_values, values)
        ? previous_version
        : previous_version + 1;
    return {
      canonical_id,
      observed_at,
      source: 'fresh-poll',
      values,
      state_version,
    };
  }

  private serviceForDesired(
    domain: string,
    desired: Readonly<Record<string, number | string | boolean>>,
  ): string {
    // turn_off when 'on' is explicitly false and we have an on-off domain.
    if (domain === 'light' || domain === 'switch' || domain === 'fan' || domain === 'cover') {
      if (desired['on'] === false) return 'turn_off';
      return 'turn_on';
    }
    return HA_DOMAIN_TO_SERVICE[domain] ?? 'turn_on';
  }

  private serviceDataForDesired(
    domain: string,
    desired: Readonly<Record<string, number | string | boolean>>,
    entity_id: string,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { entity_id };
    if (typeof desired['brightness'] === 'number') {
      data['brightness_pct'] = Math.max(0, Math.min(100, Math.round(desired['brightness'])));
    }
    if (typeof desired['color_temperature_kelvin'] === 'number') {
      data['color_temp'] = desired['color_temperature_kelvin'];
    }
    if (typeof desired['color_rgb'] === 'string') {
      const hex = desired['color_rgb'].replace('#', '');
      if (hex.length === 6) {
        data['rgb_color'] = [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ];
      }
    }
    if (domain === 'climate' && typeof desired['temperature'] === 'number') {
      data['temperature'] = desired['temperature'];
    }
    return data;
  }

  private async fetch_states(): Promise<ReadonlyArray<HARawState>> {
    const res = await this.fetch_impl(`${this.base_url}/api/states`, {
      headers: this.auth_headers(),
    });
    if (!res.ok) {
      throw new Error(`HA /api/states ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as HARawState[];
  }

  private apply_registry_snapshot(snapshot: HARegistrySnapshot | null): void {
    if (!snapshot) return;
    this.area_cache.clear();
    this.entity_to_area.clear();
    this.entity_metadata.clear();
    for (const area of snapshot.areas) this.area_cache.set(area.area_id, area);
    const devices = new Map(snapshot.devices.map((device) => [device.id, device]));
    for (const entity of snapshot.entities) {
      if (entity.area_id) this.entity_to_area.set(entity.entity_id, entity.area_id);
      const device = entity.device_id ? devices.get(entity.device_id) : undefined;
      this.entity_metadata.set(entity.entity_id, {
        ...(entity.device_id ? { device_id: entity.device_id } : {}),
        ...(entity.unique_id ? { unique_id: entity.unique_id } : {}),
        ...(entity.platform ? { platform: entity.platform } : {}),
        ...(entity.entity_category !== undefined ? { entity_category: entity.entity_category } : {}),
        ...(device ? {
          device_name: device.name_by_user ?? device.name ?? null,
          manufacturer: device.manufacturer ?? null,
          model: device.model ?? null,
        } : {}),
      });
    }
    for (const device of snapshot.devices) {
      if (!device.area_id) continue;
      for (const entity of snapshot.entities) {
        if (entity.device_id === device.id && !entity.area_id) this.entity_to_area.set(entity.entity_id, device.area_id);
      }
    }
  }

  /** Read Home Assistant's area, device, and entity registries over its authenticated WebSocket API. */
  private async fetch_registry_snapshot(): Promise<HARegistrySnapshot> {
    const socket_url = this.base_url.replace(/^http/, 'ws') + '/api/websocket';
    const socket = this.websocket_factory(socket_url);
    const commands = [
      'config/area_registry/list',
      'config/device_registry/list',
      'config/entity_registry/list',
    ] as const;
    return await new Promise<HARegistrySnapshot>((resolve, reject) => {
      let settled = false;
      let authenticated = false;
      let next_id = 1;
      const pending = new Map<number, typeof commands[number]>();
      const results = new Map<typeof commands[number], unknown>();
      const timer = setTimeout(() => finish(new Error('Home Assistant registry WebSocket timed out')), 8_000);
      const finish = (error?: Error, snapshot?: HARegistrySnapshot): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* ignore close errors */ }
        if (error) reject(error);
        else if (snapshot) resolve(snapshot);
        else reject(new Error('Home Assistant registry response was empty'));
      };
      const send_commands = (): void => {
        if (authenticated) return;
        authenticated = true;
        for (const command of commands) {
          const id = next_id++;
          pending.set(id, command);
          socket.send(JSON.stringify({ id, type: command }));
        }
      };
      socket.addEventListener('message', (event) => {
        let message: Record<string, unknown>;
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          message = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          finish(new Error('Home Assistant sent an invalid registry WebSocket message'));
          return;
        }
        if (message['type'] === 'auth_required') {
          socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
          return;
        }
        if (message['type'] === 'auth_invalid') {
          finish(new Error('Home Assistant rejected WebSocket authentication'));
          return;
        }
        if (message['type'] === 'auth_ok') {
          send_commands();
          return;
        }
        if (message['type'] !== 'result' || typeof message['id'] !== 'number') return;
        const command = pending.get(message['id']);
        if (!command) return;
        pending.delete(message['id']);
        if (message['success'] !== true) {
          finish(new Error(`Home Assistant registry command failed: ${command}`));
          return;
        }
        results.set(command, message['result']);
        if (results.size !== commands.length) return;
        const areas = results.get('config/area_registry/list');
        const devices = results.get('config/device_registry/list');
        const entities = results.get('config/entity_registry/list');
        if (!Array.isArray(areas) || !Array.isArray(devices) || !Array.isArray(entities)) {
          finish(new Error('Home Assistant returned malformed registry data'));
          return;
        }
        finish(undefined, {
          areas: areas as HARawArea[],
          devices: devices as HARegistrySnapshot['devices'],
          entities: entities as HARegistrySnapshot['entities'],
        });
      });
      socket.addEventListener('error', () => finish(new Error('Home Assistant registry WebSocket failed')));
      socket.addEventListener('close', () => {
        if (!settled) finish(new Error('Home Assistant registry WebSocket closed early'));
      });
    });
  }

  private async ensureWebSocket(): Promise<void> {
    if (this.ws && this.ws.readyState <= 1) return;
    if (this.ws_should_run) return;
    this.ws_should_run = true;
    this.openWebSocket();
  }

  private openWebSocket(): void {
    const ws_url = this.base_url.replace(/^http/, 'ws') + '/api/websocket';
    try {
      this.ws = this.websocket_factory(ws_url);
    } catch (err) {
      // Browser/node WebSocket constructor can throw on bad URLs.
      this.ws_should_run = false;
      // eslint-disable-next-line no-console
      console.error(`[hearth/ha-adapter] websocket open failed:`, (err as Error).message);
      return;
    }
    this.ws.addEventListener('open', () => {
      this.ws_reconnect_attempt = 0;
      this.ws?.send(JSON.stringify({ type: 'auth', access_token: this.token }));
    });
    this.ws.addEventListener('message', (ev) => {
      void this.handleWsMessage(ev.data as string);
    });
    this.ws.addEventListener('close', () => {
      this.ws = null;
      if (this.ws_should_run) {
        this.ws_reconnect_attempt += 1;
        const delay = Math.min(30_000, 500 * 2 ** this.ws_reconnect_attempt);
        setTimeout(() => this.openWebSocket(), delay);
      }
    });
    this.ws.addEventListener('error', () => {
      // close handler will run; reconnect logic there.
    });
  }

  private async handleWsMessage(raw: string): Promise<void> {
    let msg: { type: string; event?: { entity_id?: string; new_state?: HARawState } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'auth_ok') {
      this.ws?.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
      return;
    }
    if (msg.type === 'auth_invalid') {
      this.ws_should_run = false;
      try { this.ws?.close(); } catch { /* ignore close errors */ }
      return;
    }
    if (msg.type !== 'event' || !msg.event?.entity_id || !msg.event?.new_state) return;
    const s = msg.event.new_state;
    const canonical_id = canonicalFromEntity(s.entity_id);
    const obs = this.observationFromHA(s);
    this.state_versions.set(canonical_id, obs.state_version);
    this.last_observed.set(canonical_id, obs.observed_at);
    this.last_values.set(canonical_id, obs.values);
    for (const sub of this.subs) {
      if (sub.canonical_ids.has(canonical_id)) {
        try { sub.handler(obs); } catch { /* ignore subscriber errors */ }
      }
    }
  }

  /**
   * For tests: drop all subscriptions and tear down the websocket.
   */
  shutdown(): void {
    this.ws_should_run = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.subs.clear();
  }
}
