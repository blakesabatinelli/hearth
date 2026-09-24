import { describe, it, expect } from 'vitest';
import {
  RegistryOverlay,
  findDuplicateProviderIds,
  findUnclassifiedLoads,
  type RegistryOverlayState,
} from '../src/index.js';
import type { CanonicalId, DeviceRecord, Room, RoomId } from '@hearth/contracts';

const room1: Room = {
  room_id: 'r-living' as RoomId,
  name: 'Living Room',
  device_ids: ['d-lamp' as CanonicalId, 'd-fan' as CanonicalId],
};

const lamp: DeviceRecord = {
  canonical_id: 'd-lamp' as CanonicalId,
  friendly_name: 'Living Room Lamp',
  load_type: 'light',
  capabilities: ['on-off', 'brightness'],
  aliases: ['main lamp', 'the lamp'],
  provider_ids: [{ kind: 'ha', entity_id: 'light.living_room_lamp' }],
  room_id: 'r-living' as RoomId,
  allowed_actors: ['admin', 'member'],
  route_preference: 'ha-only',
  version: 1,
};

const fan: DeviceRecord = {
  canonical_id: 'd-fan' as CanonicalId,
  friendly_name: 'Living Room Fan',
  load_type: 'fan',
  capabilities: ['on-off'],
  aliases: ['fan', 'the fan'],
  provider_ids: [{ kind: 'ha', entity_id: 'fan.living_room' }],
  room_id: 'r-living' as RoomId,
  allowed_actors: ['admin', 'member'],
  route_preference: 'ha-only',
  version: 1,
};

const unknownSwitch: DeviceRecord = {
  canonical_id: 'd-mystery' as CanonicalId,
  friendly_name: 'Mystery Switch',
  load_type: 'unknown-switch',
  capabilities: ['on-off'],
  aliases: ['mystery'],
  provider_ids: [{ kind: 'ha', entity_id: 'switch.unknown' }],
  room_id: null,
  allowed_actors: ['admin'],
  route_preference: 'ha-only',
  version: 1,
};

// Two records sharing a provider id -> duplicate physical identity.
const duplicateA: DeviceRecord = {
  ...lamp,
  canonical_id: 'd-lamp-v2' as CanonicalId,
  provider_ids: [{ kind: 'ha', entity_id: 'light.living_room_lamp' }],
  version: 1,
};

const baseState: RegistryOverlayState = {
  devices: [lamp, fan, unknownSwitch],
  rooms: [room1],
  entity_version: 1,
  scene_versions: {},
};

describe('registry overlay', () => {
  it('resolves by friendly name', async () => {
    const r = new RegistryOverlay(baseState);
    const matches = await r.resolve('Living Room Lamp');
    expect(matches.length).toBe(1);
    expect(matches[0]?.device.canonical_id).toBe('d-lamp');
  });

  it('resolves by alias', async () => {
    const r = new RegistryOverlay(baseState);
    const matches = await r.resolve('main lamp');
    expect(matches.length).toBe(1);
    expect(matches[0]?.device.canonical_id).toBe('d-lamp');
  });

  it('resolves by exact alias (case-insensitive)', async () => {
    const r = new RegistryOverlay(baseState);
    const matches = await r.resolve('THE LAMP');
    expect(matches.length).toBe(1);
  });

  it('resolves by room name when device match is ambiguous', async () => {
    const r = new RegistryOverlay(baseState);
    const matches = await r.resolve('Living Room');
    // room match returns all devices in that room
    expect(matches.length).toBe(2);
    const ids = matches.map((m) => String(m.device.canonical_id)).sort();
    expect(ids).toEqual(['d-fan', 'd-lamp']);
  });

  it('returns empty for non-matching phrase', async () => {
    const r = new RegistryOverlay(baseState);
    const matches = await r.resolve('the bathroom mirror');
    expect(matches.length).toBe(0);
  });

  it('permission gate honors allowed_actors', async () => {
    const r = new RegistryOverlay(baseState);
    expect(await r.allowed('d-lamp' as CanonicalId, 'member')).toBe(true);
    expect(await r.allowed('d-lamp' as CanonicalId, 'wall-tablet')).toBe(false);
    // admin always allowed
    expect(await r.allowed('d-mystery' as CanonicalId, 'admin')).toBe(true);
  });

  it('permission gate rejects unknown device', async () => {
    const r = new RegistryOverlay(baseState);
    expect(await r.allowed('d-nope' as CanonicalId, 'admin')).toBe(false);
  });

  it('unknown-switch is not in the lighting scope', async () => {
    const r = new RegistryOverlay(baseState);
    const unclassified = findUnclassifiedLoads(r.snapshot());
    expect(unclassified.length).toBe(1);
    expect(unclassified[0]?.canonical_id).toBe('d-mystery');
  });

  it('detects duplicate provider ids across records', async () => {
    const r = new RegistryOverlay({
      ...baseState,
      devices: [...baseState.devices, duplicateA],
    });
    const dups = findDuplicateProviderIds(r.snapshot());
    expect(dups.length).toBe(1);
    expect(dups[0]?.canonical_ids.length).toBe(2);
  });

  it('applyEdit bumps entity_version strictly', () => {
    const r = new RegistryOverlay(baseState);
    const bumped: RegistryOverlayState = {
      ...baseState,
      entity_version: 2,
    };
    r.applyEdit(bumped);
    expect(r.entityVersion()).toBe(2);
    // Re-applying same/lower version should throw
    expect(() => r.applyEdit({ ...baseState, entity_version: 1 })).toThrow();
    expect(() => r.applyEdit({ ...baseState, entity_version: 2 })).toThrow();
  });

  it('RegistryOverlay.empty starts with version 1', () => {
    const r = RegistryOverlay.empty();
    expect(r.entityVersion()).toBe(1);
    expect(r.rooms()).toEqual([]);
  });

  it('snapshot is the version passed at construction', () => {
    const r = new RegistryOverlay(baseState);
    const snap = r.snapshot();
    expect(snap.entity_version).toBe(1);
    expect(snap.devices.length).toBe(3);
  });
});