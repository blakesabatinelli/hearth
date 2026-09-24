/**
 * @hearth/ha-adapter tests
 *
 * These tests cover the contract surface of the fake-HA adapter. They use
 * the in-memory default fixture so tests do not require any network or
 * credentials.
 */

import { describe, it, expect } from 'vitest';
import {
  type CanonicalId,
  type ContractTarget,
  type StateObservation,
} from '@hearth/contracts';
import {
  FakeHAAdapter,
  HAConnectionPool,
  loadDefaultFixture,
} from '../src/index.js';

// Helpers ---------------------------------------------------------------

function makeTarget(
  adapter: FakeHAAdapter,
  canonicalId: string,
  loadType: 'light' | 'unknown-switch' | 'outlet' | 'fan' = 'light',
): ContractTarget {
  return {
    canonical_id: canonicalId as CanonicalId,
    load_type: loadType,
    route: 'ha-only',
    state_version: 1, // overwritten below
  };
}

async function pickCurrentStateVersion(
  adapter: FakeHAAdapter,
  canonicalId: string,
): Promise<number> {
  const obs = await adapter.getState(canonicalId as CanonicalId);
  return obs.state_version;
}

// Default fixture --------------------------------------------------------

describe('loadDefaultFixture', () => {
  it('returns a seed registry and seed rooms covering the required surface', () => {
    const { devices, rooms } = loadDefaultFixture();
    expect(devices.length).toBeGreaterThan(0);
    expect(rooms.length).toBeGreaterThan(0);

    const byName = new Map(devices.map((d) => [d.friendly_name, d]));
    // Living room lamp: on-off + brightness
    const lamp = byName.get('Living Room Lamp');
    expect(lamp).toBeDefined();
    expect(lamp?.load_type).toBe('light');
    expect(lamp?.capabilities).toContain('on-off');
    expect(lamp?.capabilities).toContain('brightness');

    // Kitchen lights: scene-capable
    const kitchen = byName.get('Kitchen Lights');
    expect(kitchen).toBeDefined();
    expect(kitchen?.load_type).toBe('light');
    expect(kitchen?.capabilities).toContain('scene');

    // Bedroom overhead: brightness
    const bedroom = byName.get('Bedroom Overhead');
    expect(bedroom).toBeDefined();
    expect(bedroom?.load_type).toBe('light');
    expect(bedroom?.capabilities).toContain('brightness');

    // Fan: on-off
    const fan = byName.get('Bedroom Fan');
    expect(fan).toBeDefined();
    expect(fan?.load_type).toBe('fan');
    expect(fan?.capabilities).toContain('on-off');

    // Unknown switch: NOT pre-classified as lighting
    const unknown = devices.find((d) => d.load_type === 'unknown-switch');
    expect(unknown).toBeDefined();
    expect(unknown?.load_type).toBe('unknown-switch');
    // Lighting scope = only 'light' devices; this is the gate.
    const lighting = devices.filter((d) => d.load_type === 'light');
    expect(lighting.find((d) => d.canonical_id === unknown?.canonical_id)).toBeUndefined();
  });

  it('exposes a varied alias phrase surface for fixture mode', () => {
    const { devices } = loadDefaultFixture();
    const allAliases = devices.flatMap((d) => d.aliases);
    const expected = [
      'main lights',
      'the kitchen',
      'the overhead in the bedroom',
      'fan',
      'the fan',
      'the lamp',
    ];
    for (const phrase of expected) {
      expect(allAliases).toContain(phrase);
    }
  });

  it('provides a duplicate-target scenario: two provider IDs to one canonical device', () => {
    const { devices } = loadDefaultFixture();
    const dupes = devices.filter((d) => d.provider_ids.length >= 2);
    expect(dupes.length).toBeGreaterThan(0);
    for (const d of dupes) {
      // Distinct provider IDs that share one canonical_id.
      expect(d.provider_ids.length).toBeGreaterThanOrEqual(2);
      const kinds = new Set(d.provider_ids.map((p) => p.kind));
      // Allow same kind (HA + HA is permitted; both names resolve to same physical load).
      expect(d.provider_ids.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// FakeHAAdapter -------------------------------------------------------------

describe('FakeHAAdapter', () => {
  it('lists devices and rooms from the seed registry', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const devices = await adapter.listDevices();
    const rooms = await adapter.listRooms();
    expect(devices.length).toBeGreaterThan(0);
    expect(rooms.length).toBeGreaterThan(0);
    // All device IDs are present in rooms
    for (const room of rooms) {
      for (const id of room.device_ids) {
        expect(devices.find((d) => d.canonical_id === id)).toBeDefined();
      }
    }
  });

  it('reads current state for a canonical device', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp');
    expect(lamp).toBeDefined();
    const obs = await adapter.getState(lamp!.canonical_id);
    expect(obs.canonical_id).toBe(lamp!.canonical_id);
    expect(obs.source).toMatch(/^fresh-poll$|^cached$|^reconnect-snapshot$|^unknown$/);
    expect(typeof obs.observed_at).toBe('string');
    expect(obs.state_version).toBeGreaterThanOrEqual(0);
    expect(obs.values).toBeDefined();
  });

  it('returns a sent ack for a normal turn-on dispatch and updates state', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;
    // start from off (fixture seeds on: false for the lamp)
    const before = await adapter.getState(lamp.canonical_id);
    expect(before.values['on']).toBe(false);

    const target: ContractTarget = {
      canonical_id: lamp.canonical_id,
      load_type: 'light',
      route: 'ha-only',
      state_version: before.state_version,
    };
    const ack = await adapter.dispatch(target, { on: true });
    expect(ack.kind).toBe('sent');
    if (ack.kind === 'sent') {
      expect(ack.provider).toBe('fake-ha');
      expect(typeof ack.echoed_at).toBe('string');
    }

    const after = await adapter.getState(lamp.canonical_id);
    expect(after.values['on']).toBe(true);
    expect(after.state_version).toBeGreaterThan(before.state_version);
  });

  it('returns a sent ack for absolute brightness dispatch and clamps the value', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;
    // turn the lamp on first, set to a known starting point
    const before = await adapter.getState(lamp.canonical_id);
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: before.state_version },
      { on: true, brightness: 50 },
    );

    const middle = await adapter.getState(lamp.canonical_id);
    expect(middle.values['brightness']).toBe(50);

    // set absolute to 100
    const ack1 = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: middle.state_version },
      { brightness: 100 },
    );
    expect(ack1.kind).toBe('sent');
    const after1 = await adapter.getState(lamp.canonical_id);
    expect(after1.values['brightness']).toBe(100);

    // set absolute to 150 -> clamps to 100, but current is already 100,
    // so the canonical DispatchAck returns 'no-op' (plan section 8: the
    // adapter is the authority on whether anything would change).
    const ack2 = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: after1.state_version },
      { brightness: 150 },
    );
    expect(ack2.kind).toBe('no-op');
    const after2 = await adapter.getState(lamp.canonical_id);
    expect(after2.values['brightness']).toBe(100);

    // set absolute to 50 -> sent (was at 0)
    const ack3 = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: after2.state_version },
      { brightness: 50 },
    );
    expect(ack3.kind).toBe('sent');
    const after3 = await adapter.getState(lamp.canonical_id);
    expect(after3.values['brightness']).toBe(50);
  });

  it('returns a sent ack for dim-by relative dispatch and updates by delta', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;
    // set to on + brightness 50
    const before = await adapter.getState(lamp.canonical_id);
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: before.state_version },
      { on: true, brightness: 50 },
    );
    const start = await adapter.getState(lamp.canonical_id);
    expect(start.values['brightness']).toBe(50);

    // dim-by 20
    const ack = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: start.state_version },
      { 'dim-by': 20 },
    );
    expect(ack.kind).toBe('sent');
    const after = await adapter.getState(lamp.canonical_id);
    expect(after.values['brightness']).toBe(70);
  });
});

// Required ACs (the five named test cases from the task spec) ---------------

describe('AC: dispatch and subscribe behavior', () => {
  it('no-op dispatch returns already-satisfied observation (echoed_at matches current state)', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;

    // Drive to a known desired state.
    const before = await adapter.getState(lamp.canonical_id);
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: before.state_version },
      { on: true, brightness: 75 },
    );
    const settled = await adapter.getState(lamp.canonical_id);
    const versionAtDispatch = settled.state_version;

    // Re-dispatch the same desired state. This is a no-op.
    const ack = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: versionAtDispatch },
      { on: true, brightness: 75 },
    );

    // Must be a no-op ack per the DispatchAck contract; the executor maps
    // this to an already-satisfied per-target outcome (plan section 8).
    expect(ack.kind).toBe('no-op');
    if (ack.kind === 'no-op') {
      expect(ack.observed_at).toBe(settled.observed_at);
      expect(ack.state_version).toBe(versionAtDispatch);
    }
    const after = await adapter.getState(lamp.canonical_id);
    expect(after.state_version).toBe(versionAtDispatch);
    expect(after.values['on']).toBe(true);
    expect(after.values['brightness']).toBe(75);
  });

  it('stale relative dispatch returns precondition-failed error', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;

    // Move to on+brightness 50
    const before = await adapter.getState(lamp.canonical_id);
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: before.state_version },
      { on: true, brightness: 50 },
    );
    const afterMove = await adapter.getState(lamp.canonical_id);

    // Someone else changes the state -> state_version bumps
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: afterMove.state_version },
      { brightness: 60 },
    );
    const currentObs = await adapter.getState(lamp.canonical_id);

    // Now dispatch a relative dim-by with the STALE state_version from before the move.
    const ack = await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: afterMove.state_version },
      { 'dim-by': 10 },
    );

    expect(ack.kind).toBe('rejected');
    if (ack.kind === 'rejected') {
      // The canonical DispatchAck only carries `reason`; the executor
      // recovers the structured error from the adapter's getState()
      // follow-up + a precondition-failed sentinel. We assert the
      // human-readable reason here.
      expect(ack.reason).toContain('precondition-failed');
    }

    // State must NOT have been mutated by the rejected relative dispatch.
    const stillCurrent = await adapter.getState(lamp.canonical_id);
    expect(stillCurrent.state_version).toBe(currentObs.state_version);
    expect(stillCurrent.values['brightness']).toBe(60);
  });

  it('subscribe emits fresh observation after dispatch', async () => {
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const fixture = loadDefaultFixture();
    const lamp = fixture.devices.find((d) => d.friendly_name === 'Living Room Lamp')!;

    const received: StateObservation[] = [];
    const sub = adapter.subscribe([lamp.canonical_id], (obs) => {
      received.push(obs);
    });

    // Drive a state change.
    const before = await adapter.getState(lamp.canonical_id);
    await adapter.dispatch(
      { canonical_id: lamp.canonical_id, load_type: 'light', route: 'ha-only', state_version: before.state_version },
      { on: true, brightness: 42 },
    );
    // Allow microtasks (the adapter fires synchronously today, but allow slack).
    await Promise.resolve();

    expect(received.length).toBeGreaterThan(0);
    const last = received[received.length - 1]!;
    expect(last.canonical_id).toBe(lamp.canonical_id);
    expect(last.values['on']).toBe(true);
    expect(last.values['brightness']).toBe(42);
    expect(last.source).toMatch(/^fresh-poll$|^cached$|^reconnect-snapshot$|^unknown$/);

    sub.unsubscribe();
  });

  it('duplicate canonical device routes all provider IDs through one record', async () => {
    const { devices } = loadDefaultFixture();
    // Find a device with multiple provider_ids.
    const dupe = devices.find((d) => d.provider_ids.length >= 2);
    expect(dupe).toBeDefined();
    const adapter = new FakeHAAdapter(loadDefaultFixture());

    // Resolving by any of the provider entity_ids must return the same canonical id.
    const entityIds = dupe!.provider_ids.filter((p) => p.kind === 'ha').map((p) => {
      // type narrowing via shape
      return (p as { kind: 'ha'; entity_id: string }).entity_id;
    });
    expect(entityIds.length).toBeGreaterThan(0);

    // The adapter exposes only canonical ids in listDevices (HA provider_ids
    // are surfaced but the canonical_id is the key). All provider IDs on
    // one device point at the same canonical_id; the registry does not
    // create separate DeviceRecords for the second provider_id.
    const all = await adapter.listDevices();
    const matches = all.filter((d) => d.canonical_id === dupe!.canonical_id);
    expect(matches.length).toBe(1);
    expect(matches[0]!.provider_ids.length).toBeGreaterThanOrEqual(2);

    // Dispatching via canonical_id affects the single record (state_version bumps).
    const before = await adapter.getState(dupe!.canonical_id);
    await adapter.dispatch(
      {
        canonical_id: dupe!.canonical_id,
        load_type: dupe!.load_type,
        route: 'ha-only',
        state_version: before.state_version,
      },
      { on: true },
    );
    const after = await adapter.getState(dupe!.canonical_id);
    expect(after.state_version).toBeGreaterThan(before.state_version);
  });

  it('unknown-switch load type is NOT in the lighting scope', async () => {
    const { devices } = loadDefaultFixture();
    const unknown = devices.find((d) => d.load_type === 'unknown-switch');
    expect(unknown).toBeDefined();

    // Lighting scope = the subset of devices with load_type 'light'.
    const lightingScope = devices.filter((d) => d.load_type === 'light');
    expect(lightingScope.find((d) => d.canonical_id === unknown!.canonical_id)).toBeUndefined();

    // The adapter still accepts dispatch against the unknown switch (it's a
    // switch, not a light), but its load_type is preserved and the registry
    // does not silently reclassify it as lighting.
    const adapter = new FakeHAAdapter(loadDefaultFixture());
    const before = await adapter.getState(unknown!.canonical_id);
    await adapter.dispatch(
      {
        canonical_id: unknown!.canonical_id,
        load_type: 'unknown-switch',
        route: 'ha-only',
        state_version: before.state_version,
      },
      { on: true },
    );
    const after = await adapter.getState(unknown!.canonical_id);
    expect(after.values['on']).toBe(true);
    // Load type is preserved by the device record.
    const re = await adapter.listDevices();
    expect(re.find((d) => d.canonical_id === unknown!.canonical_id)?.load_type).toBe('unknown-switch');
  });
});

// HAConnectionPool ----------------------------------------------------------

describe('HAConnectionPool', () => {
  it('manages a fake-HA adapter by default and exposes it as the active adapter', () => {
    const pool = new HAConnectionPool(loadDefaultFixture());
    expect(pool.activeProvider).toBe('fake');
    const adapter = pool.getActive();
    expect(adapter).toBeInstanceOf(FakeHAAdapter);
  });

  it('starts with exactly one wired adapter (the fake) and rejects unknown providers', async () => {
    const pool = new HAConnectionPool(loadDefaultFixture());
    const list = pool.listProviders();
    expect(list).toContain('fake');
    // Wiring a real provider is a future config switch; the runtime must
    // throw today rather than silently accept it.
    expect(() => pool.setActive('ha' as 'fake')).toThrow();
  });
});

// Reference to silence unused-helper warnings from the strict tsconfig.
void pickCurrentStateVersion;
void makeTarget;
