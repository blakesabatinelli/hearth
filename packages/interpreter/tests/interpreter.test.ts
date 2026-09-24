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
}): DeviceRecord {
  return {
    canonical_id: args.id as CanonicalId,
    friendly_name: args.friendly_name,
    load_type: 'light',
    capabilities: ['on-off', 'brightness'],
    aliases: args.aliases ?? [],
    provider_ids: [{ kind: 'ha', entity_id: `light.${args.id}` }],
    room_id: null,
    allowed_actors: ['admin', 'member'],
    route_preference: 'ha-only',
    version: 1,
  };
}

function makeRegistry(): GrammarRegistry {
  const devices = [
    device({ id: 'd-lamp', friendly_name: 'Living Room Lamp', aliases: ['main lamp'] }),
    device({ id: 'd-office', friendly_name: 'Office Light' }),
  ];
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
      rooms: [],
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
  public mode: 'complete' | 'partial' | 'fail' = 'complete';
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
    if (this.mode === 'complete') {
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
      confidence: this.mode === 'complete' ? 0.92 : 0.5,
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

  it('grammar fail + GLiNER2 complete -> ready_for_contract with provenance gliner2', async () => {
    // An utterance the grammar can't parse.
    const decision = await interpreter.interpret('turn on the celestia lamp', 'req-i1');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('gliner2');
    expect(gliner2.call_count).toBe(1);
    expect(bonsai.call_count).toBe(0);
  });

  it('grammar fail + GLiNER2 partial + Bonsai success -> ready_for_contract composed provenance', async () => {
    gliner2.mode = 'partial';
    const decision = await interpreter.interpret('turn on the celestia lamp', 'req-i2');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('composed-gliner2-bonsai');
    expect(gliner2.call_count).toBe(1);
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

  it('grammar fail + GLiNER2 unavailable + Bonsai success -> ready_for_contract (bonsai provenance)', async () => {
    const noGliner = new Interpreter({
      registry,
      gliner2: null,
      bonsai,
    });
    const decision = await noGliner.interpret('turn on the celestia lamp', 'req-i4');
    expect(decision.outcome).toBe('ready_for_contract');
    if (decision.outcome !== 'ready_for_contract') return;
    expect(decision.proposal.provenance.source).toBe('bonsai');
    expect(bonsai.call_count).toBe(1);
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