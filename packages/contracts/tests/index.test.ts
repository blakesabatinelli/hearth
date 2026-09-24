import { describe, it, expect } from 'vitest';
import {
  HEARTH_SCHEMA_VERSION,
  HEARTH_OPENCLAW_PIN,
  type IntentProposal,
  type Contract,
  type DeviceRecord,
} from '../src/index.js';

describe('contracts package', () => {
  it('exports a frozen schema version', () => {
    expect(HEARTH_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(HEARTH_OPENCLAW_PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('IntentProposal carries NO actor_id/role/policy fields', () => {
    // Compile-time check via TypeScript; runtime check via field enumeration
    const fake: IntentProposal = {
      request_id: 'r1',
      intent_family: 'set-brightness-absolute',
      target_phrases: ['living room'],
      exclusions: [],
      desired_values: { brightness: 50 },
      temporal: null,
      unresolved_fields: [],
      confidence: 0.9,
    };
    const keys = Object.keys(fake);
    expect(keys).not.toContain('actor_id');
    expect(keys).not.toContain('role');
    expect(keys).not.toContain('actor');
    expect(keys).not.toContain('allowed_devices');
    expect(keys).not.toContain('policy');
    expect(keys).not.toContain('expiry_at');
    expect(keys).not.toContain('retry_limit');
  });

  it('Contract contains server-derived actor and policy fields', () => {
    // Sanity-check by construction; the types enforce this at compile time.
    const fake: Contract = {
      contract_id: 'c1',
      actor: {
        actor_id: 'a1',
        role: 'member',
        session_id: 's1',
      },
      request_id: 'r1',
      intent_family: 'set-state',
      targets: [],
      exclusions: [],
      desired_values: {},
      entity_version: 1,
      scene_version: null,
      preconditions: [],
      expiry_at: '2026-09-24T12:00:00Z',
      allowed_routes: ['ha-only'],
      per_target_evidence: {},
      status: 'pending',
      created_at: '2026-09-24T11:59:00Z',
    };
    expect(fake.actor.role).toBe('member');
    expect(fake.status).toBe('pending');
  });

  it('DeviceRecord carries provider_ids with discriminants', () => {
    const d: DeviceRecord = {
      canonical_id: 'd1' as DeviceRecord['canonical_id'],
      friendly_name: 'Living Room Lamp',
      load_type: 'light',
      capabilities: ['on-off', 'brightness'],
      aliases: ['main lamp'],
      provider_ids: [{ kind: 'ha', entity_id: 'light.living_room_lamp' }],
      room_id: null,
      allowed_actors: ['admin', 'member'],
      route_preference: 'ha-only',
      version: 1,
    };
    expect(d.provider_ids[0]?.kind).toBe('ha');
  });
});