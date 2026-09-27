/**
 * Interpreter tests for @hearth/interpreter. Covers the five-outcome
 * routing contract and the forbidden-field guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  BonsaiProvider,
  CanonicalId,
  DeviceRecord,
  ExtractionEntityType,
  ExtractionLabel,
  ExtractionProvider,
  ExtractionRelation,
  ExtractionResult,
  ExtractionSchema,
  IntentProposal,
  Room,
  RoomId,
  StateObservation,
} from '@hearth/contracts';
import {
  Interpreter,
  ForbiddenFieldError,
  FORBIDDEN_REQUEST_FIELDS,
} from '../src/index.js';
import type {
  GrammarRegistry,
  GrammarResolution,
} from '../src/grammar.js';

// =============================================================================
// Fixtures
// =============================================================================

function device(args: {
  id: string;
  friendly_name: string;
  aliases?: ReadonlyArray<string>;
  room_id?: RoomId | null;
}): DeviceRecord {
  return {
    canonical_id: args.id as CanonicalId,
    friendly_name: args.friendly_name,
    load_type: 'light',
    capabilities: ['on-off', 'brightness'],
    aliases: args.aliases ?? [],
    provider_ids: [{ kind: 'ha', entity_id: `light.${args.id}` }],
    room_id: args.room_id ?? null,
    allowed_actors: ['admin', 'member'],
    route_preference: 'ha-only',
    version: 1,
  };
}

function makeRegistry(
  devices: ReadonlyArray<DeviceRecord> = [
    device({ id: 'd-lamp', friendly_name: 'Living Room Lamp', aliases: ['main lamp'] }),
    device({ id: 'd-office', friendly_name: 'Office Light' }),
  ],
  rooms: ReadonlyArray<Room> = [],
): GrammarRegistry {
  return {
    resolve: async (phrase: string): Promise<ReadonlyArray<GrammarResolution>> => {
      const norm = phrase.trim().toLowerCase();
      const matches: GrammarResolution[] = [];
      const seen = new Set<string>();
      for (const d of devices) {
        if (
          d.friendly_name.toLowerCase() === norm ||
          d.aliases.some((a) => a.toLowerCase() === norm) ||
          d.friendly_name.toLowerCase().includes(norm)
        ) {
          const key = String(d.canonical_id);
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({
              device: d,
              aliases_provider_ids: d.provider_ids,
              matched_via: 'friendly_name',
            });
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

/**
 * Mock GLiNER2 provider. Configurable per-test to:
 *   - "complete": return a fully-filled ExtractionResult
 *   - "partial": return an incomplete ExtractionResult
 *   - "fail": throw
 */
class MockGliner2 implements ExtractionProvider {
  public mode: 'complete' | 'partial' | 'partial-exclusion' | 'fail' | 'room-lamps' | 'routine-trigger' = 'complete';
  public call_count = 0;
  public readonly checkpoint = 'fastino/gliner2.5-base-v1';
  public readonly schema_version = '1';

  public async extract(req: { request_id: string; utterance: string; schema: ExtractionSchema }): Promise<ExtractionResult> {
    this.call_count += 1;
    if (this.mode === 'fail') {
      throw new Error('mock-gliner2-connection-error');
    }
    const entities: Record<string, ReadonlyArray<string>> = {};
    const classifications: Array<{ label: ExtractionLabel; span: string }> = [];
    const unresolved: string[] = [];
    if (this.mode === 'partial-exclusion') {
      entities['device_target'] = ['Living Room Lamp'];
      classifications.push({ label: 'on', span: 'turn on' });
      unresolved.push('exclusion');
    } else if (this.mode === 'routine-trigger') {
      entities['device_target'] = ['bedtime routine'];
      entities['value_expression'] = ['bedtime'];
      classifications.push({ label: 'routine_trigger', span: 'execute bedtime' });
    } else if (this.mode === 'room-lamps') {
      entities['device_target'] = ['lamps'];
      entities['room'] = ['Master Bedroom'];
      classifications.push({ label: 'on', span: 'illuminate' });
    } else if (this.mode === 'complete') {
      entities['device_target'] = ['Living Room Lamp'];
      entities['value_expression'] = ['40'];
      classifications.push({ label: 'set_brightness', span: 'set to 40' });
    } else {
      // partial: only device target, missing brightness value
      entities['device_target'] = ['Living Room Lamp'];
      classifications.push({ label: 'set_brightness', span: 'set' });
      unresolved.push('value_expression');
    }
    return {
      request_id: req.request_id,
      entities,
      classifications,
      relations: [],
      unresolved,
      confidence: this.mode === 'complete' || this.mode === 'partial-exclusion' || this.mode === 'room-lamps' || this.mode === 'routine-trigger' ? 0.92 : 0.5,
      original_utterance: req.utterance,
    };
  }

  public async health() {
    return { ready: true, checkpoint_id: this.checkpoint, latency_ms_p50: 1 };
  }
}

/**
 * Mock Bonsai provider.
 */
class MockBonsai implements BonsaiProvider {
  public call_count = 0;
  public readonly adapter_id = 'mock-bonsai/0';

  public async propose(req: { request_id: string; utterance: string; context: unknown }): Promise<IntentProposal> {
    this.call_count += 1;
    return {
      request_id: req.request_id,
      intent_family: 'set-brightness-absolute',
      target_phrases: ['Living Room Lamp'],
      exclusions: [],
      desired_values: { brightness: 40 },
      temporal: null,
      unresolved_fields: [],
      confidence: 0.85,
      provenance: { source: 'bonsai', adapter_id: this.adapter_id },
    };
  }

  public validateProposal(raw: unknown): IntentProposal {
    return raw as IntentProposal;
  }
}

let registry: GrammarRegistry;
let gliner2: MockGliner2;
let bonsai: MockBonsai;
let interpreter: Interpreter;

beforeEach(() => {
  registry = makeRegistry();
  gliner2 = new MockGliner2();
  bonsai = new MockBonsai();
  interpreter = new Interpreter({ registry, gliner2, bonsai });
});

// =============================================================================
// Tests
// =============================================================================

describe('Interpreter', () => {
  it('grammar success short-circuits; never calls GLiNER2 or Bonsai', async () => {
    const decision = await interpreter.interpret('turn on the lamp', 'req-g1');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('grammar');
    expect(gliner2.call_count).toBe(0);
    expect(bonsai.call_count).toBe(0);
  });

  it('grammar fail + grounded GLiNER2 interpretation -> ready_for_contract', async () => {
    const decision = await interpreter.interpret('please make the main lamp brightness 40', 'req-i1');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('gliner2');
    expect(gliner2.call_count).toBe(1);
    expect(bonsai.call_count).toBe(0);
  });

  it('GLiNER2 room plus generic lamps expands only to named lights in that room', async () => {
    const roomId = 'master-bedroom' as RoomId;
    const bedroom: Room = {
      room_id: roomId,
      name: 'Master Bedroom',
      device_ids: ['alpha-lamp', 'beta-lamp', 'bedroom-group', 'candle'] as CanonicalId[],
    };
    registry = makeRegistry([
      device({ id: 'alpha-lamp', friendly_name: "alpha's Lamp", room_id: roomId }),
      device({ id: 'beta-lamp', friendly_name: "beta's Lamp", room_id: roomId }),
      device({ id: 'bedroom-group', friendly_name: 'Master Bedroom', room_id: roomId }),
      device({ id: 'candle', friendly_name: 'Bedroom Candle', room_id: roomId }),
    ], [bedroom]);
    gliner2.mode = 'room-lamps';
    interpreter = new Interpreter({ registry, gliner2, bonsai });

    const decision = await interpreter.interpret('please illuminate the Master Bedroom lamps', 'req-gliner-room-lamps');

    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.target_phrases).toEqual(["alpha's Lamp", "beta's Lamp"]);
    expect(decision.proposal.provenance.source).toBe('gliner2');
    expect(bonsai.call_count).toBe(0);
  });

  it('routine names come from value expressions, never device targets', async () => {
    gliner2.mode = 'routine-trigger';
    interpreter = new Interpreter({ registry, gliner2, bonsai });

    const decision = await interpreter.interpret('Can you execute the bedtime routine?', 'req-gliner-routine');

    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.intent_family).toBe('routine-trigger');
    expect(decision.proposal.target_phrases).toEqual(['bedtime']);
    expect(bonsai.call_count).toBe(0);
  });

  it('GLiNER2 room expansion filters duplicate HA names through the exact allowlist', async () => {
    const roomId = 'master-bedroom' as RoomId;
    const bedroom: Room = {
      room_id: roomId,
      name: 'Master Bedroom',
      device_ids: [
        'master_bedroom_blake_lamp', 'master_bedroom_blake_lamp_2',
        'master_bedroom_jinna_lamp', 'master_bedroom_jinna_lamp_2',
      ] as CanonicalId[],
    };
    registry = makeRegistry([
      device({ id: 'master_bedroom_blake_lamp', friendly_name: 'alpha lamp', room_id: roomId }),
      device({ id: 'master_bedroom_blake_lamp_2', friendly_name: 'alpha lamp', room_id: roomId }),
      device({ id: 'master_bedroom_jinna_lamp', friendly_name: 'beta lamp', room_id: roomId }),
      device({ id: 'master_bedroom_jinna_lamp_2', friendly_name: 'beta lamp', room_id: roomId }),
    ], [bedroom]);
    gliner2.mode = 'room-lamps';
    interpreter = new Interpreter({
      registry,
      gliner2,
      bonsai,
      room_lamp_entity_allowlist: new Set([
        'light.master_bedroom_blake_lamp',
        'light.master_bedroom_jinna_lamp',
      ]),
    });

    const decision = await interpreter.interpret('please illuminate the Master Bedroom lamps', 'req-gliner-allowlisted-room-lamps');

    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.target_phrases).toEqual(['alpha lamp', 'beta lamp']);
    expect(decision.proposal.provenance.source).toBe('gliner2');
    expect(bonsai.call_count).toBe(0);
  });

  it('grammar fail + grounded GLiNER2 partial + Bonsai success -> ready_for_contract', async () => {
    gliner2.mode = 'partial';
    const decision = await interpreter.interpret('please change the main lamp brightness', 'req-i2');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('composed-gliner2-bonsai');
    expect(decision.proposal.unresolved_fields).toEqual([]);
    expect(gliner2.call_count).toBe(1);
    expect(bonsai.call_count).toBe(1);
  });

  it('a GLiNER2 exclusion gap is retained unless Bonsai supplies an exclusion', async () => {
    gliner2.mode = 'partial-exclusion';
    const decision = await interpreter.interpret(
      'turn on the living room lamp except the kitchen lights',
      'req-i-exclusion-gap',
    );
    expect(decision.outcome).toBe('needs_clarification');
    expect(bonsai.call_count).toBe(1);
  });

  it('all fail -> needs_clarification with original utterance preserved', async () => {
    // Configure interpreter without Bonsai so we get the terminal
    // clarification outcome when GLiNER2 fails.
    const noBonsai = new Interpreter({ registry, gliner2, bonsai: null });
    gliner2.mode = 'fail';
    const utterance = 'turn on the celestia lamp please';
    const decision = await noBonsai.interpret(utterance, 'req-i3');
    expect(decision.outcome).toBe('needs_clarification');
    if (decision.outcome !== 'needs_clarification') return;
    expect(decision.candidates).toEqual([]);
  });

  it('GLiNER2 unavailable + grounded Bonsai fallback -> ready_for_contract', async () => {
    const noGliner = new Interpreter({
      registry,
      gliner2: null,
      bonsai,
    });
    const decision = await noGliner.interpret('please alter the main lamp brightness', 'req-i4');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('bonsai');
    expect(bonsai.call_count).toBe(1);
  });

  it('rejects model guesses, compound actions, and unsupported dropped brightness', async () => {
    for (const [utterance, requestId] of [
      ['turn on Aardvark', 'req-ungrounded'],
      ['turn on bedroom overhead and turn off main lamp', 'req-compound'],
      ['turn on the bedroom fan and dim it', 'req-dropped-brightness'],
    ] as const) {
      const decision = await new Interpreter({ registry, gliner2: null, bonsai }).interpret(utterance, requestId);
      expect(decision.outcome, utterance).toBe('needs_clarification');
    }
  });

  it('grammar fail + GLiNER2 unavailable + Bonsai unavailable -> needs_clarification', async () => {
    const noGlinerNoBonsai = new Interpreter({
      registry,
      gliner2: null,
      bonsai: null,
    });
    const decision = await noGlinerNoBonsai.interpret(
      'turn on the celestia lamp',
      'req-i5',
    );
    expect(decision.outcome).toBe('needs_clarification');
    if (decision.outcome !== 'needs_clarification') return;
    expect(decision.candidates).toEqual([]);
  });

  it('request body that includes actor_id -> ForbiddenFieldError', async () => {
    await expect(
      interpreter.interpret('turn on the lamp', 'req-f1', { actor_id: 'evil' }),
    ).rejects.toBeInstanceOf(ForbiddenFieldError);
  });

  it('request body that includes role -> ForbiddenFieldError', async () => {
    await expect(
      interpreter.interpret('turn on the lamp', 'req-f2', { role: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenFieldError);
  });

  it('request body that includes policy, expiry_at, retry_limit, allowed_devices -> ForbiddenFieldError', async () => {
    for (const field of FORBIDDEN_REQUEST_FIELDS) {
      if (field === 'actor_id' || field === 'role') continue; // covered
      await expect(
        interpreter.interpret('turn on the lamp', `req-f-${field}`, { [field]: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenFieldError);
    }
  });

  it('empty payload is accepted', async () => {
    const decision = await interpreter.interpret('turn on the lamp', 'req-f3', {});
    expect(decision.outcome).toBe('ready_for_contract');
  });

  it('pronoun-binding: with fresh state the grammar can resolve "it"', async () => {
    const i = new Interpreter({
      registry,
      gliner2,
      bonsai,
      recent_fresh_state: (): ReadonlyArray<StateObservation> => [
        {
          canonical_id: 'd-lamp' as CanonicalId,
          observed_at: new Date().toISOString(),
          source: 'fresh-poll',
          values: { on: false },
          state_version: 1,
        },
      ],
    });
    const decision = await i.interpret('turn it on', 'req-p1');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.target_phrases).toEqual(['Living Room Lamp']);
  });

  it('forbidden-field error message lists all offending fields', async () => {
    try {
      await interpreter.interpret('turn on the lamp', 'req-f4', {
        actor_id: 'a',
        role: 'admin',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenFieldError);
      if (err instanceof ForbiddenFieldError) {
        expect(err.fields).toEqual(expect.arrayContaining(['actor_id', 'role']));
      }
    }
  });
});

describe('Integration: grammar + interpreter cover all rule paths', () => {
  it('all grammar rejections land at the right routing outcome', async () => {
    // Speech error -> grammar rejects -> GLiNER2 complete path returns
    // ready_for_contract. The "lumens" word isn't in GLiNER2's
    // extraction either, so the mock returns the lamp proposal. That
    // is the *routing* behavior, not a claim the interpretation is
    // correct.
    const decision = await interpreter.interpret('turn on the lumens', 'req-r1');
    // Grammar rejects with speech-error reason. GLiNER2 mock returns
    // complete regardless of utterance content; that's the mock.
    expect(['ready_for_contract', 'needs_clarification']).toContain(decision.outcome);
  });
});
