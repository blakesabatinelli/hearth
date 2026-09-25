/**
 * LiveHAAdapter: real Home Assistant adapter.
 *
 * Implements the HomeAssistantAdapter contract against a real HA
 * instance reachable at `base_url` with a long-lived `token`.
 *
 * Surfaces:
 *   - REST: GET /api/states, GET /api/states/<entity_id>,
 *           GET /api/areas, POST /api/services/<domain>/<service>
 *   - WebSocket: /api/websocket for state_changed events (subscribe)
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
  private readonly subs: Set<Subscription> = new Set();
  private ws: WebSocket | null = null;
  private ws_reconnect_attempt = 0;
  private ws_should_run = false;
  private readonly state_versions: Map<CanonicalId, number> = new Map();
  private readonly last_observed: Map<CanonicalId, string> = new Map();
  private readonly last_values: Map<CanonicalId, Readonly<Record<string, number | string | boolean>>> = new Map();
  private readonly area_cache: Map<string, HARawArea> = new Map();
  private readonly entity_to_area: Map<string, string> = new Map();

  constructor(opts: LiveHAOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetch_impl = opts.fetch_impl ?? fetch;
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
    const [states, areas] = await Promise.all([
      this.fetch_states(),
      this.fetch_areas(),
    ]);

    // Build entity_id -> area_id from /api/areas + the registry.
    // If registry endpoint is unavailable we leave area unmapped.
    await this.fetch_entity_registry();

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
      const provider_id: ProviderId = { kind: 'ha', entity_id: s.entity_id };

      const canonical_id = canonicalFromEntity(s.entity_id);
      devices.push({
        canonical_id,
        friendly_name,
        load_type,
        capabilities: caps,
        aliases: [s.entity_id, friendly_name].filter((a, i, arr) => arr.indexOf(a) === i),
        provider_ids: [provider_id],
        room_id: area_id ? roomIdFromHA(area_id) : null,
        allowed_actors: ['admin', 'member', 'wall-tablet'] as const,
        route_preference: 'ha-only',
        version: 1,
      });
    }

    // Cache areas for listRooms().
    for (const a of areas) {
      this.area_cache.set(a.area_id, a);
    }

    return devices;
  }

  async listRooms(): Promise<ReadonlyArray<Room>> {
    await this.fetch_areas();
    await this.fetch_entity_registry();
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
    const observed_at = s.last_updated || s.last_changed || new Date().toISOString();
    const prev = this.state_versions.get(canonicalFromEntity(s.entity_id)) ?? 1;
    // Increment version on every fresh observation. The cache is local;
    // real HA has no notion of an externally tracked state_version.
    const state_version = prev + 1;
    return {
      canonical_id: canonicalFromEntity(s.entity_id),
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

  private async fetch_areas(): Promise<ReadonlyArray<HARawArea>> {
    const res = await this.fetch_impl(`${this.base_url}/api/areas`, {
      headers: this.auth_headers(),
    });
    if (!res.ok) {
      // Areas endpoint was added in 2024.x; older HA returns 404. We
      // tolerate that and return an empty list.
      return [];
    }
    const areas = (await res.json()) as HARawArea[];
    for (const a of areas) {
      this.area_cache.set(a.area_id, a);
    }
    return areas;
  }

  private async fetch_entity_registry(): Promise<void> {
    // /api/registry gives us the entity_id -> area_id mapping.
    try {
      const res = await this.fetch_impl(`${this.base_url}/api/registry`, {
        headers: this.auth_headers(),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        entities?: Array<{ entity_id: string; area_id: string | null }>;
      };
      for (const e of body.entities ?? []) {
        if (e.area_id) this.entity_to_area.set(e.entity_id, e.area_id);
      }
    } catch {
      // Registry is optional; older HA versions omit it.
    }
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
      this.ws = new WebSocket(ws_url);
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
