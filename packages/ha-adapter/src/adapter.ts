/**
 * Fake-HA adapter implementation.
 *
 * In-memory simulation of a small household. Implements the
 * HomeAssistantAdapter contract from @hearth/contracts with a wider local
 * dispatch result type so the fixture can surface the already-satisfied
 * observation and the precondition-failed DispatchError inline. The wider
 * type is structurally a subtype of DispatchAck so this class still
 * satisfies the published interface.
 */

import {
  type CanonicalId,
  type ContractTarget,
  type DeviceRecord,
  type DispatchAck,
  type DispatchError,
  type HomeAssistantAdapter,
  type Room,
  type RoomId,
  type StateHandler,
  type StateObservation,
  type UnsubscribeableSubscription,
} from '@hearth/contracts';

// =============================================================================
// Local types
// =============================================================================

/**
 * Wider local dispatch result. Structural subtype of `DispatchAck` so the
 * FakeHAAdapter still satisfies `implements HomeAssistantAdapter`. The
 * extras are the information a real HA transport could not give us but
 * the fixture can: the time we observed the device, its state version,
 * Public dispatch returns the canonical `DispatchAck` from
 * `@hearth/contracts`. The contract now includes a `no-op` variant for the
 * fast-path "state already matches" case (plan section 8), so this adapter
 * no longer needs a local wider subtype.
 */
/** A subscription entry. */
type Subscription = {
  readonly canonical_ids: ReadonlySet<CanonicalId>;
  readonly handler: StateHandler;
};

/** Seed for the fake-HA registry: devices and rooms. */
export type FixtureSeed = {
  readonly devices: ReadonlyArray<DeviceRecord>;
  readonly rooms: ReadonlyArray<Room>;
};

// =============================================================================
// Internal device record + state
// =============================================================================

type InternalDevice = DeviceRecord & {
  // Mutable state values. Kept parallel to the contract: a Record of
  // number | string | boolean.
  readonly state: {
    values: Record<string, number | string | boolean>;
    state_version: number;
    observed_at: string;
  };
};

const cloneDeviceRecord = (d: DeviceRecord): InternalDevice => ({
  ...d,
  state: {
    values: { ...initialValuesForDevice(d) },
    state_version: 0,
    observed_at: new Date(0).toISOString(),
  },
});

/**
 * Choose a reasonable initial state for a device based on its load type
 * and capabilities. Brightness defaults to 100 when the device supports
 * it (we'll treat 'on' as the on-state marker; brightness is independent).
 */
function initialValuesForDevice(d: DeviceRecord): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = { on: false };
  if (d.capabilities.includes('brightness')) out['brightness'] = 0;
  if (d.capabilities.includes('color-temperature')) out['color_temperature_kelvin'] = 2700;
  if (d.capabilities.includes('color-rgb')) out['color_rgb'] = '#ffffff';
  if (d.capabilities.includes('scene')) out['scene'] = 'normal';
  return out;
}

// =============================================================================
// FakeHAAdapter
// =============================================================================

/**
 * In-memory Home Assistant adapter. The fixture-mode default; real HA is
 * a future config switch.
 */
export class FakeHAAdapter implements HomeAssistantAdapter {
  private readonly devices: Map<CanonicalId, InternalDevice>;
  private readonly rooms: ReadonlyArray<Room>;
  private readonly subs: Set<Subscription>;

  constructor(seed: FixtureSeed) {
    this.devices = new Map();
    for (const d of seed.devices) {
      this.devices.set(d.canonical_id, cloneDeviceRecord(d));
    }
    this.rooms = seed.rooms;
    this.subs = new Set();
  }

  // ---- HomeAssistantAdapter surface ---------------------------------------

  async listDevices(): Promise<ReadonlyArray<DeviceRecord>> {
    // Surface only the contract fields, not the internal state.
    return Array.from(this.devices.values(), ({ canonical_id, friendly_name, load_type, capabilities, aliases, provider_ids, room_id, allowed_actors, route_preference, version }) => ({
      canonical_id,
      friendly_name,
      load_type,
      capabilities,
      aliases,
      provider_ids,
      room_id,
      allowed_actors,
      route_preference,
      version,
    }));
  }

  async listRooms(): Promise<ReadonlyArray<Room>> {
    return this.rooms;
  }

  async getState(canonical_id: CanonicalId): Promise<StateObservation> {
    const d = this.requireDevice(canonical_id);
    return {
      canonical_id,
      observed_at: d.state.observed_at,
      source: 'cached',
      values: { ...d.state.values },
      state_version: d.state.state_version,
    };
  }

  async dispatch(
    target: ContractTarget,
    desired_values: Readonly<Record<string, number | string | boolean>>,
  ): Promise<DispatchAck> {
    return this.dispatchDetailed(target, desired_values);
  }

  subscribe(
    canonical_ids: ReadonlyArray<CanonicalId>,
    handler: StateHandler,
  ): UnsubscribeableSubscription {
    const sub: Subscription = {
      canonical_ids: new Set(canonical_ids),
      handler,
    };
    this.subs.add(sub);
    return {
      unsubscribe: () => {
        this.subs.delete(sub);
      },
    };
  }

  // Local dispatch: returns the canonical DispatchAck union
  // (sent | rejected | no-op) directly. dispatch() below exposes it on
  // the HomeAssistantAdapter contract surface.
  dispatchDetailed(
    target: ContractTarget,
    desired_values: Readonly<Record<string, number | string | boolean>>,
  ): Promise<DispatchAck> {
    return Promise.resolve(this._dispatchSync(target, desired_values));
  }

  private _dispatchSync(
    target: ContractTarget,
    desired_values: Readonly<Record<string, number | string | boolean>>,
  ): DispatchAck {
    const d = this.requireDevice(target.canonical_id);

    // Compute the next-state plan first so we can detect the no-op
    // fast-path BEFORE bumping state_version or sending a state-changed
    // event to subscribers.
    const plan = this.planDispatch(d, desired_values);

    // Stale-state check for RELATIVE dispatches: if the request was bound
    // to a state_version that is no longer current, reject with
    // precondition-failed. Relative dispatches are NOT idempotent against
    // a stale baseline (plan section 8).
    const isRelative = this.containsRelativeKey(desired_values);
    if (isRelative && target.state_version !== d.state.state_version) {
      return {
        kind: 'rejected',
        reason: 'precondition-failed: state_version mismatch on relative dispatch',
      };
    }

    // No-op fast-path: if the planned state already matches current, do
    // not bump the version and do not emit a state-changed event. Return
    // the canonical no-op DispatchAck so the executor can record
    // already-satisfied immediately (plan section 8).
    if (plan.noOp) {
      return {
        kind: 'no-op',
        observed_at: d.state.observed_at,
        state_version: d.state.state_version,
      };
    }

    // Apply the plan.
    for (const [k, v] of Object.entries(plan.nextValues)) {
      d.state.values[k] = v;
    }
    d.state.state_version += 1;
    d.state.observed_at = new Date().toISOString();

    // Emit to subscribers.
    this.emit(d);

    return {
      kind: 'sent',
      provider: 'fake-ha',
      echoed_at: d.state.observed_at,
    };
  }

  // ---- helpers ------------------------------------------------------------

  private requireDevice(canonical_id: CanonicalId): InternalDevice {
    const d = this.devices.get(canonical_id);
    if (!d) {
      throw new Error(`unknown canonical_id: ${canonical_id}`);
    }
    return d;
  }

  private containsRelativeKey(
    desired: Readonly<Record<string, number | string | boolean>>,
  ): boolean {
    return Object.prototype.hasOwnProperty.call(desired, 'dim-by') ||
           Object.prototype.hasOwnProperty.call(desired, 'dim_by') ||
           Object.prototype.hasOwnProperty.call(desired, 'brightness-by');
  }

  private planDispatch(
    d: InternalDevice,
    desired: Readonly<Record<string, number | string | boolean>>,
  ): {
    readonly nextValues: Record<string, number | string | boolean>;
    readonly noOp: boolean;
  } {
    const next: Record<string, number | string | boolean> = { ...d.state.values };

    for (const [key, raw] of Object.entries(desired)) {
      if (key === 'on') {
        const v = Boolean(raw);
        next['on'] = v;
      } else if (key === 'brightness') {
        // absolute 0..100, clamp
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        const clamped = Math.max(0, Math.min(100, Math.round(n)));
        next['brightness'] = clamped;
      } else if (key === 'dim-by' || key === 'dim_by' || key === 'brightness-by') {
        // relative; clamp result to 0..100
        const current = Number(next['brightness'] ?? 0);
        const delta = Number(raw);
        if (!Number.isFinite(delta)) continue;
        const result = Math.max(0, Math.min(100, Math.round(current + delta)));
        next['brightness'] = result;
      } else if (key === 'scene') {
        next['scene'] = String(raw);
      } else if (key === 'color_temperature_kelvin') {
        next['color_temperature_kelvin'] = Number(raw);
      } else if (key === 'color_rgb') {
        next['color_rgb'] = String(raw);
      } else {
        // Unknown key: pass through as-is. The contract permits any
        // string/number/boolean under desired_values.
        next[key] = raw;
      }
    }

    // No-op: nothing would actually change.
    const noOp = this.valuesEqual(d.state.values, next);
    return { nextValues: noOp ? d.state.values : next, noOp };
  }

  private valuesEqual(
    a: Readonly<Record<string, number | string | boolean>>,
    b: Readonly<Record<string, number | string | boolean>>,
  ): boolean {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  private emit(d: InternalDevice): void {
    if (this.subs.size === 0) return;
    const obs: StateObservation = {
      canonical_id: d.canonical_id,
      observed_at: d.state.observed_at,
      source: 'fresh-poll',
      values: { ...d.state.values },
      state_version: d.state.state_version,
    };
    for (const sub of this.subs) {
      if (sub.canonical_ids.has(d.canonical_id)) {
        try {
          sub.handler(obs);
        } catch {
          // Subscriber errors must not affect dispatch path.
        }
      }
    }
  }
}

// =============================================================================
// HAConnectionPool
// =============================================================================

/**
 * Provider-key discriminator. Today only `fake` is wired. A future real-HA
 * implementation would add 'ha' here and `setActive` would route between
 * them.
 */
export type ProviderKey = 'fake';

/**
 * Manages the set of registered HA providers and which one is currently
 * active. For now only the fake provider is wired; switching to a real HA
 * provider is a future config switch (plan section 13 Stage 1 gate).
 */
export class HAConnectionPool {
  private readonly adapters: Map<ProviderKey, HomeAssistantAdapter> = new Map();
  private active: ProviderKey = 'fake';

  constructor(seed: FixtureSeed) {
    const fake = new FakeHAAdapter(seed);
    this.adapters.set('fake', fake);
  }

  get activeProvider(): ProviderKey {
    return this.active;
  }

  getActive(): HomeAssistantAdapter {
    const a = this.adapters.get(this.active);
    if (!a) {
      throw new Error(`active provider not wired: ${this.active}`);
    }
    return a;
  }

  listProviders(): ReadonlyArray<ProviderKey> {
    return Array.from(this.adapters.keys());
  }

  /**
   * Future: switch to a registered provider. Today only `fake` is
   * registered; requesting any other key throws so we fail loud rather
   * than silently no-op.
   */
  setActive(_key: ProviderKey): void {
    if (!this.adapters.has(_key)) {
      throw new Error(
        `provider not wired: ${String(_key)} (only fake is wired in fixture mode)`,
      );
    }
    this.active = _key;
  }
}

// =============================================================================
// Default fixture
// =============================================================================

const cid = (s: string): CanonicalId => s as CanonicalId;
const rid = (s: string): RoomId => s as RoomId;

/**
 * Default synthetic household. Used by tests and demo mode. See package
 * README for the human-readable layout. Required fixture contents (per
 * task spec):
 *
 * - Living Room Lamp: on-off + brightness
 * - Kitchen Lights: scene-capable on/off/dim/scene
 * - Bedroom Overhead: brightness
 * - Bedroom Fan: on-off
 * - Unknown-switch load: NOT pre-classified as lighting
 * - Duplicate-target scenario: at least one DeviceRecord with multiple
 *   provider_ids that resolve to the same canonical device
 *
 * Aliases provide a varied phrase surface for the interpreter:
 * "main lights", "the kitchen", "the overhead in the bedroom", "fan",
 * "the fan", "the lamp".
 */
export function loadDefaultFixture(): FixtureSeed {
  const devices: DeviceRecord[] = [
    {
      canonical_id: cid('dev-living-room-lamp'),
      friendly_name: 'Living Room Lamp',
      load_type: 'light',
      capabilities: ['on-off', 'brightness'],
      aliases: [
        'the lamp',
        'living room lamp',
        'lamp',
        'main lamp',
        'living room light',
      ],
      provider_ids: [
        { kind: 'ha', entity_id: 'light.living_room_lamp' },
      ],
      room_id: rid('room-living-room'),
      allowed_actors: ['admin', 'member'],
      route_preference: 'ha-only',
      version: 1,
    },
    {
      canonical_id: cid('dev-kitchen-lights'),
      friendly_name: 'Kitchen Lights',
      load_type: 'light',
      capabilities: ['on-off', 'brightness', 'scene'],
      aliases: [
        'the kitchen',
        'kitchen lights',
        'main lights',
        'kitchen',
        'kitchen light',
      ],
      provider_ids: [
        { kind: 'ha', entity_id: 'light.kitchen_main' },
        // Duplicate-target scenario: same canonical device, second
        // provider ID. Both HA entities drive the same physical load.
        { kind: 'ha', entity_id: 'light.kitchen_main_alt' },
      ],
      room_id: rid('room-kitchen'),
      allowed_actors: ['admin', 'member'],
      route_preference: 'ha-only',
      version: 1,
    },
    {
      canonical_id: cid('dev-bedroom-overhead'),
      friendly_name: 'Bedroom Overhead',
      load_type: 'light',
      capabilities: ['on-off', 'brightness'],
      aliases: [
        'the overhead in the bedroom',
        'bedroom overhead',
        'overhead',
        'bedroom light',
        'main bedroom light',
      ],
      provider_ids: [
        { kind: 'ha', entity_id: 'light.bedroom_overhead' },
      ],
      room_id: rid('room-bedroom'),
      allowed_actors: ['admin', 'member'],
      route_preference: 'ha-only',
      version: 1,
    },
    {
      canonical_id: cid('dev-bedroom-fan'),
      friendly_name: 'Bedroom Fan',
      load_type: 'fan',
      capabilities: ['on-off'],
      aliases: [
        'fan',
        'the fan',
        'bedroom fan',
      ],
      provider_ids: [
        { kind: 'ha', entity_id: 'fan.bedroom' },
      ],
      room_id: rid('room-bedroom'),
      allowed_actors: ['admin', 'member'],
      route_preference: 'ha-only',
      version: 1,
    },
    {
      canonical_id: cid('dev-unknown-switch'),
      friendly_name: 'Mystery Switch',
      load_type: 'unknown-switch',
      capabilities: ['on-off'],
      aliases: [
        'mystery switch',
        'the mystery switch',
      ],
      provider_ids: [
        { kind: 'ha', entity_id: 'switch.mystery' },
      ],
      room_id: rid('room-living-room'),
      allowed_actors: ['admin'],
      route_preference: 'ha-only',
      version: 1,
    },
  ];

  const rooms: Room[] = [
    {
      room_id: rid('room-living-room'),
      name: 'Living Room',
      device_ids: [
        cid('dev-living-room-lamp'),
        cid('dev-unknown-switch'),
      ],
    },
    {
      room_id: rid('room-kitchen'),
      name: 'Kitchen',
      device_ids: [cid('dev-kitchen-lights')],
    },
    {
      room_id: rid('room-bedroom'),
      name: 'Bedroom',
      device_ids: [
        cid('dev-bedroom-overhead'),
        cid('dev-bedroom-fan'),
      ],
    },
  ];

  return { devices, rooms };
}

// =============================================================================
// Re-exports of contract types used by callers (no runtime cost).
// =============================================================================

export type {
  CanonicalId,
  ContractTarget,
  DeviceRecord,
  DispatchAck,
  DispatchError,
  HomeAssistantAdapter,
  Room,
  RoomId,
  StateHandler,
  StateObservation,
  UnsubscribeableSubscription,
};
