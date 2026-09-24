/**
 * Grammar tests for @hearth/interpreter.
 *
 * Each test sets up a small in-memory registry fixture and exercises one
 * grammar rule or rejection rule. Fixtures live here so the grammar
 * tests are deterministic and have no shared state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  CanonicalId,
  DeviceRecord,
  LoadType,
  Room,
  RoomId,
} from '@hearth/contracts';
import { GrammarParser, type GrammarRegistry, type GrammarResolution } from '../src/grammar.js';

// =============================================================================
// Fixtures
// =============================================================================

function device(args: {
  id: string;
  friendly_name: string;
  load_type?: LoadType;
  aliases?: ReadonlyArray<string>;
  room_id?: RoomId | null;
}): DeviceRecord {
  return {
    canonical_id: args.id as CanonicalId,
    friendly_name: args.friendly_name,
    load_type: args.load_type ?? 'light',
    capabilities: ['on-off', 'brightness'],
    aliases: args.aliases ?? [],
    provider_ids: [{ kind: 'ha', entity_id: `light.${args.id}` }],
    room_id: args.room_id ?? null,
    allowed_actors: ['admin', 'member'],
    route_preference: 'ha-only',
    version: 1,
  };
}

function room(args: { id: string; name: string; device_ids: ReadonlyArray<string> }): Room {
  return {
    room_id: args.id as RoomId,
    name: args.name,
    device_ids: args.device_ids as ReadonlyArray<CanonicalId>,
  };
}

function makeRegistry(devices: ReadonlyArray<DeviceRecord>, rooms: ReadonlyArray<Room> = []): GrammarRegistry {
  return {
    resolve: async (phrase: string): Promise<ReadonlyArray<GrammarResolution>> => {
      const norm = phrase.trim().toLowerCase();
      if (norm.length === 0) return [];
      const matches: GrammarResolution[] = [];
      const seen = new Set<string>();
      for (const d of devices) {
        const idMatch = d.canonical_id === phrase;
        const aliasMatch = d.aliases.some((a) => a.toLowerCase() === norm);
        const friendlyExact = d.friendly_name.toLowerCase() === norm;
        const friendlySubstring = d.friendly_name.toLowerCase().includes(norm);
        if (idMatch || aliasMatch || friendlyExact || friendlySubstring) {
          const key = String(d.canonical_id);
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              device: d,
              aliases_provider_ids: d.provider_ids,
              matched_via: idMatch ? 'exact-id' : aliasMatch ? 'alias' : 'friendly_name',
            });
          }
        }
      }
      if (matches.length === 0) {
        const matchingRoom = rooms.find((r) => r.name.toLowerCase() === norm);
        if (matchingRoom) {
          for (const d of devices) {
            if (d.room_id === matchingRoom.room_id) {
              matches.push({
                device: d,
                aliases_provider_ids: d.provider_ids,
                matched_via: 'room',
              });
            }
          }
        }
      }
      return matches;
    },
    device: (canonical_id: CanonicalId): DeviceRecord | null => {
      return devices.find((d) => d.canonical_id === canonical_id) ?? null;
    },
    snapshot: () => ({
      devices,
      rooms,
      entity_version: 1,
      scene_versions: {},
    }),
  };
}

let registry: GrammarRegistry;
let parser: GrammarParser;

beforeEach(() => {
  registry = makeRegistry([
    device({
      id: 'd-lamp',
      friendly_name: 'Living Room Lamp',
      aliases: ['main lamp', 'the lamp'],
    }),
    device({
      id: 'd-office',
      friendly_name: 'Office Light',
      aliases: ['office'],
    }),
    device({
      id: 'd-porch-unknown',
      friendly_name: 'Porch Switch',
      load_type: 'unknown-switch',
      aliases: ['porch', 'porch light'],
    }),
    device({
      id: 'd-fan',
      friendly_name: 'Living Room Fan',
      load_type: 'fan',
      aliases: ['fan'],
    }),
  ]);
  parser = new GrammarParser({ registry });
});

// =============================================================================
// Tests
// =============================================================================

describe('GrammarParser', () => {
  it('turn on the lamp -> set-state on=true, provenance grammar', async () => {
    const r = await parser.parse('turn on the lamp', 'req-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-state');
    expect(r.proposal.target_phrases).toEqual(['Living Room Lamp']);
    expect(r.proposal.desired_values.on).toBe(true);
    expect(r.proposal.provenance.source).toBe('grammar');
    expect(r.proposal.unresolved_fields).toEqual([]);
    expect(r.proposal.exclusions).toEqual([]);
    expect(r.proposal.temporal).toBeNull();
  });

  it('dim by 10 percent -> set-brightness-relative with delta -10', async () => {
    const r = await parser.parse('dim the lamp by 10 percent', 'req-2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-brightness-relative');
    expect(r.proposal.desired_values.brightness_delta).toBe(-10);
    if (r.proposal.provenance.source === 'grammar') {
      expect(r.proposal.provenance.matched_rule).toBe('dim-by@1');
    }
  });

  it('brighten by 10 percent -> set-brightness-relative with delta +10', async () => {
    const r = await parser.parse('brighten the lamp by 10 percent', 'req-3');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-brightness-relative');
    expect(r.proposal.desired_values.brightness_delta).toBe(10);
    if (r.proposal.provenance.source === 'grammar') {
      expect(r.proposal.provenance.matched_rule).toBe('brighten-by@1');
    }
  });

  it('"do not turn on the lamp" -> reject the fast path (negation)', async () => {
    const r = await parser.parse('do not turn on the lamp', 'req-4');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/negation/i);
    expect(r.residual_utterance).toBe('do not turn on the lamp');
  });

  it('"don\'t switch off the lamp" -> reject the fast path (negation)', async () => {
    const r = await parser.parse("don't switch off the lamp", 'req-4b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/negation/i);
  });

  it('two distinct actions ("turn on the lamp and dim the office") -> reject', async () => {
    const r = await parser.parse('turn on the lamp and dim the office', 'req-5');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/multiple actions/i);
    expect(r.residual_utterance).toBe('turn on the lamp and dim the office');
  });

  it('"all off except office" -> set-state on=false with exclusions=[Office Light]', async () => {
    const r = await parser.parse('all off except office', 'req-6');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-state');
    expect(r.proposal.target_phrases).toEqual(['everything']);
    expect(r.proposal.exclusions).toEqual(['Office Light']);
    expect(r.proposal.desired_values.on).toBe(false);
  });

  it('"turn on the lamp until midnight" -> hold-until with temporal.until', async () => {
    const r = await parser.parse('turn on the lamp until midnight', 'req-7');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('hold-until');
    expect(r.proposal.temporal).not.toBeNull();
    if (r.proposal.temporal) {
      expect(r.proposal.temporal.kind).toBe('until');
    }
  });

  it('"turn on the lamp until sunrise" -> hold-until with after-sunrise', async () => {
    const r = await parser.parse('turn on the lamp until sunrise', 'req-7b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('hold-until');
    expect(r.proposal.temporal).not.toBeNull();
    if (r.proposal.temporal) {
      expect(r.proposal.temporal.kind).toBe('after-sunrise');
    }
  });

  it('"turn on the celestia lamp" -> unknown target, reject with residual', async () => {
    const r = await parser.parse('turn on the celestia lamp', 'req-8');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/did not resolve|residual|target/i);
    expect(r.residual_utterance).toBe('turn on the celestia lamp');
  });

  it('misleading name: "porch light" resolves to unknown-switch, flags load_type', async () => {
    const r = await parser.parse('turn on the porch light', 'req-9');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.target_phrases).toEqual(['Porch Switch']);
    // desired_values carries the load_type hint so the contract
    // executor can warn on dispatch.
    expect(r.proposal.desired_values.load_type).toBe('unknown-switch');
    expect(r.proposal.desired_values.on).toBe(true);
  });

  it('speech error "lumens" -> reject fast path', async () => {
    const r = await parser.parse('turn on the lumens', 'req-10');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/speech-error/i);
  });

  it('speech error "lam" -> reject fast path', async () => {
    const r = await parser.parse('turn on the lam', 'req-10b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/speech-error/i);
  });

  it('set absolute: "set the lamp to 50 percent" -> brightness=50', async () => {
    const r = await parser.parse('set the lamp to 50 percent', 'req-11');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-brightness-absolute');
    expect(r.proposal.desired_values.brightness).toBe(50);
  });

  it('set absolute: "the lamp at 50 percent" -> brightness=50', async () => {
    const r = await parser.parse('the lamp at 50 percent', 'req-11b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.brightness).toBe(50);
  });

  it('set absolute: "brightness 30 on the lamp" -> brightness=30', async () => {
    const r = await parser.parse('brightness 30 on the lamp', 'req-11c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.brightness).toBe(30);
  });

  it('"X down 10" -> relative delta -10', async () => {
    const r = await parser.parse('the lamp down 10', 'req-12');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.brightness_delta).toBe(-10);
  });

  it('"X up 10" -> relative delta +10', async () => {
    const r = await parser.parse('the lamp up 10', 'req-13');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.brightness_delta).toBe(10);
  });

  it('pronoun "turn it on" without context -> reject', async () => {
    const r = await parser.parse('turn it on', 'req-14');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pronoun|fresh state/i);
  });

  it('pronoun "turn it on" with fresh-state context -> resolves to last device', async () => {
    const lastId: CanonicalId = 'd-lamp' as CanonicalId;
    const lampRecord = registry.device(lastId);
    expect(lampRecord).not.toBeNull();
    const r = await parser.parse('turn it on', 'req-14b', {
      pronoun_resolution: {
        last_device: lastId,
        has_recent_fresh_state: true,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-state');
    expect(r.proposal.target_phrases).toEqual(['Living Room Lamp']);
  });

  it('"run morning routine" -> routine-trigger', async () => {
    const r = await parser.parse('run morning routine', 'req-15');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('routine-trigger');
    expect(r.proposal.target_phrases).toEqual(['morning routine']);
  });

  it('"trigger goodnight" -> routine-trigger', async () => {
    const r = await parser.parse('trigger goodnight', 'req-15b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('routine-trigger');
  });

  it('"turn off everything except office and lamp" -> multiple exclusions reject', async () => {
    const r = await parser.parse('turn off everything except office and lamp', 'req-16');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/multiple exclusions/i);
  });

  it('switch on X -> set-state on=true', async () => {
    const r = await parser.parse('switch on the lamp', 'req-17');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.on).toBe(true);
  });

  it('switch off X -> set-state on=false', async () => {
    const r = await parser.parse('switch off the lamp', 'req-18');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.on).toBe(false);
  });

  it('"X on" shorthand -> set-state on=true', async () => {
    const r = await parser.parse('the lamp on', 'req-19');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.on).toBe(true);
  });

  it('"X off" shorthand -> set-state on=false', async () => {
    const r = await parser.parse('the lamp off', 'req-20');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.desired_values.on).toBe(false);
  });

  it('a little dimmer without fresh state -> reject (vague relative requires fresh state)', async () => {
    const r = await parser.parse('the lamp to a little dimmer', 'req-21');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/fresh state/i);
  });

  it('a little dimmer with fresh state -> relative -10', async () => {
    const r = await parser.parse('the lamp to a little dimmer', 'req-21b', {
      pronoun_resolution: {
        last_device: 'd-lamp' as CanonicalId,
        has_recent_fresh_state: true,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.intent_family).toBe('set-brightness-relative');
    expect(r.proposal.desired_values.brightness_delta).toBe(-10);
  });

  it('provenance matched_rule is stable and identifies the pattern', async () => {
    const r = await parser.parse('turn on the lamp', 'req-22');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.provenance.source).toBe('grammar');
    if (r.proposal.provenance.source === 'grammar') {
      expect(typeof r.proposal.provenance.matched_rule).toBe('string');
      expect(r.proposal.provenance.matched_rule.length).toBeGreaterThan(0);
    }
  });

  it('confidence is 1.0 for grammar matches', async () => {
    const r = await parser.parse('turn on the lamp', 'req-23');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.confidence).toBe(1);
  });
});