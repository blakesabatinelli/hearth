/**
 * Interpreter - the routing layer that decides whether to call GLiNER2
 * and/or Bonsai. Per ADR-2026-09-24-gliner2-required and plan section 7,
 * the order is:
 *
 *   1. Grammar (cheapest, deterministic)
 *   2. GLiNER2 (schema-driven, CPU-first)
 *   3. Bonsai (contextual reasoning, last resort)
 *
 * The interpreter is the ONLY place these three layers coordinate. It
 * never calls device adapters. It only produces RoutingDecisions and
 * IntentProposals. The contract executor does the dispatching.
 */

import type {
  ActorRole,
  BonsaiProvider,
  CanonicalId,
  DeviceRecord,
  ExtractionEntityType,
  ExtractionLabel,
  ExtractionProvider,
  ExtractionRelation,
  ExtractionResult,
  ExtractionSchema,
  IntentFamily,
  IntentProposal,
  LoadType,
  ProposalContext,
  ProposalProvenance,
  ProviderId,
  RoutingDecision,
  StateObservation,
  TemporalClause,
} from '@hearth/contracts';
import { GrammarParser, type GrammarRegistry, type GrammarRegistrySnapshot, type PronounResolution } from './grammar.js';
import { buildExtractionSchema } from './schema.js';

// =============================================================================
// Public types
// =============================================================================

export type InterpreterOptions = {
  readonly registry: GrammarRegistry;
  /**
   * GLiNER2 extraction provider. May be null when the GLiNER2 path is
   * unavailable (no sidecar, doctor failure, etc.). In that case the
   * interpreter routes directly from grammar to Bonsai or clarification.
   */
  readonly gliner2: ExtractionProvider | null;
  /**
   * Bonsai reasoning provider. May be null when Bonsai is unavailable.
   * When null, the interpreter can only route to clarification after
   * grammar + GLiNER2 fail.
   */
  readonly bonsai: BonsaiProvider | null;
  /**
   * Pronoun binding source. Plan section 7: pronouns ("it", "that one")
   * resolve against recent fresh state; without it the grammar rejects.
   * We accept a synchronous getter so the interpreter can pull the
   * current binding per request without coupling to the runtime.
   */
  readonly recent_fresh_state?: () => ReadonlyArray<StateObservation>;
  /**
   * Confidence threshold for accepting a GLiNER2 extraction as
   * ready_for_contract. Defaults to 0.7 per the spec.
   */
  readonly gliner2_confidence_threshold?: number;
  /**
   * In live mode, constrain room-wide lamp expansion to exact HA entities
   * approved by the local executor allowlist. Omitted only in fixture mode.
   */
  readonly room_lamp_entity_allowlist?: ReadonlySet<string>;
};

export type InterpreterInterpretOptions = {
  /**
   * Schema version forwarded to GLiNER2 so the sidecar can pin the right
   * extraction behavior. Defaults to the contracts' HEARTH_SCHEMA_VERSION
   * when omitted.
   */
  readonly schema_version?: string;
};

// =============================================================================
// Forbidden fields
// =============================================================================

/**
 * These fields are SERVER-DERIVED. The interpreter must NEVER accept
 * them from a request body. The interface enforces this at compile time
 * (InterpreterInterpretOptions) and at runtime (rejectForbiddenFields).
 */
export const FORBIDDEN_REQUEST_FIELDS = [
  'actor_id',
  'role',
  'policy',
  'allowed_devices',
  'expiry_at',
  'retry_limit',
] as const;

export class ForbiddenFieldError extends Error {
  public readonly fields: ReadonlyArray<string>;
  public constructor(message: string, fields: ReadonlyArray<string>) {
    super(message);
    this.name = 'ForbiddenFieldError';
    this.fields = fields;
  }
}

// =============================================================================
// Interpreter
// =============================================================================

export class Interpreter {
  private readonly registry: GrammarRegistry;
  private readonly gliner2: ExtractionProvider | null;
  private readonly bonsai: BonsaiProvider | null;
  private readonly recent_fresh_state: () => ReadonlyArray<StateObservation>;
  private readonly gliner2_confidence_threshold: number;
  private readonly room_lamp_entity_allowlist: ReadonlySet<string> | undefined;
  private readonly grammar: GrammarParser;

  public constructor(opts: InterpreterOptions) {
    if (!opts || !opts.registry) {
      throw new Error('Interpreter requires a registry');
    }
    this.registry = opts.registry;
    this.gliner2 = opts.gliner2;
    this.bonsai = opts.bonsai;
    this.recent_fresh_state = opts.recent_fresh_state ?? (() => []);
    this.gliner2_confidence_threshold = opts.gliner2_confidence_threshold ?? 0.7;
    this.room_lamp_entity_allowlist = opts.room_lamp_entity_allowlist;
    this.grammar = new GrammarParser({
      registry: opts.registry,
      ...(opts.room_lamp_entity_allowlist !== undefined
        ? { room_lamp_entity_allowlist: opts.room_lamp_entity_allowlist }
        : {}),
    });
  }

  /**
   * Interpret a natural-language utterance and return a RoutingDecision.
   *
   * Throws ForbiddenFieldError if the supplied request payload contains
   * server-derived fields. The interface deliberately does not type
   * those fields; the runtime check is a defense-in-depth net.
   */
  public async interpret(
    utterance: string,
    request_id: string,
    payload: Record<string, unknown> = {},
    options: InterpreterInterpretOptions = {},
  ): Promise<RoutingDecision> {
    rejectForbiddenFields(payload);

    // Step 1: grammar. If it succeeds, return immediately and never
    // touch GLiNER2 or Bonsai.
    const pronoun_resolution = this.buildPronounResolution();
    const grammarResult = await this.grammar.parse(utterance, request_id, {
      pronoun_resolution,
    });
    if (grammarResult.ok) {
      return { outcome: 'ready_for_contract', proposal: grammarResult.proposal };
    }

    // Step 2: GLiNER2. The schema is built from the current registry +
    // supported command categories.
    const schema = buildExtractionSchema(this.registry, {
      ...(options.schema_version !== undefined ? { schema_version: options.schema_version } : {}),
    });
    if (this.gliner2 !== null) {
      try {
        const extraction = await this.gliner2.extract({ request_id, utterance, schema });
        const proposal = await this.tryGliner2ToProposal(extraction, request_id);
        if (proposal !== null) {
          return await this.isSafeFallbackProposal(utterance, proposal)
            ? { outcome: 'ready_for_contract', proposal }
            : {
              outcome: 'needs_clarification',
              reason: 'model interpretation was not grounded in the request or omitted a constraint',
              candidates: [],
            };
        }
        // Extraction incomplete. If Bonsai is configured, hand the
        // partial to Bonsai and produce a composed proposal; otherwise
        // ask the user.
        if (this.bonsai !== null) {
          try {
            const bonsaiProposal = await this.bonsai.propose({
              request_id,
              utterance,
              context: this.buildProposalContext(),
            });
            // Compose: prepend gliner2's checkpoint_id to provenance.
            const composed = composeProvenance(bonsaiProposal, extraction);
            if (!await this.isSafeFallbackProposal(utterance, composed)) {
              return {
                outcome: 'needs_clarification',
                reason: 'model interpretation was not grounded in the request or omitted a constraint',
                candidates: [],
              };
            }
            return { outcome: 'ready_for_contract', proposal: composed };
          } catch (err) {
            return {
              outcome: 'needs_clarification',
              reason: `bonsai failed after gliner2 partial: ${errorMessage(err)}`,
              candidates: [],
            };
          }
        }
        return {
          outcome: 'needs_clarification',
          reason:
            'gliner2 extraction incomplete and bonsai unavailable; cannot resolve without user input',
          candidates: [],
        };
      } catch (err) {
        // GLiNER2 failed; if Bonsai is configured, route to it.
        if (this.bonsai !== null) {
          try {
            const bonsaiProposal = await this.bonsai.propose({
              request_id,
              utterance,
              context: this.buildProposalContext(),
            });
            if (!await this.isSafeFallbackProposal(utterance, bonsaiProposal)) {
              return {
                outcome: 'needs_clarification',
                reason: 'model interpretation was not grounded in the request or omitted a constraint',
                candidates: [],
              };
            }
            return { outcome: 'ready_for_contract', proposal: bonsaiProposal };
          } catch (err2) {
            return {
              outcome: 'needs_clarification',
              reason: `gliner2 failed (${errorMessage(err)}) and bonsai failed (${errorMessage(err2)})`,
              candidates: [],
            };
          }
        }
        return {
          outcome: 'needs_clarification',
          reason: `gliner2 failed and bonsai unavailable: ${errorMessage(err)}`,
          candidates: [],
        };
      }
    }

    // Step 3: Bonsai. Grammar failed and GLiNER2 is not configured.
    if (this.bonsai !== null) {
      try {
        const proposal = await this.bonsai.propose({
          request_id,
          utterance,
          context: this.buildProposalContext(),
        });
        if (!await this.isSafeFallbackProposal(utterance, proposal)) {
          return {
            outcome: 'needs_clarification',
            reason: 'model interpretation was not grounded in the request or omitted a constraint',
            candidates: [],
          };
        }
        return { outcome: 'ready_for_contract', proposal };
      } catch (err) {
        return {
          outcome: 'needs_clarification',
          reason: `bonsai failed: ${errorMessage(err)}`,
          candidates: [],
        };
      }
    }

    // Step 4: nothing left. Return the original utterance so the user
    // is asked, not a model asked to guess.
    return {
      outcome: 'needs_clarification',
      reason: grammarResult.reason,
      candidates: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Pronoun resolution
  // ---------------------------------------------------------------------------

  private buildPronounResolution(): PronounResolution {
    const recent = this.recent_fresh_state();
    if (recent.length === 0) {
      return { last_device: null, has_recent_fresh_state: false };
    }
    // The most recent fresh observation is the binding target. We only
    // accept "fresh-poll" or "reconnect-snapshot" sources; cached or
    // unknown sources cannot bind pronouns (plan section 8).
    const sorted = [...recent].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    const fresh = sorted.find(
      (o) => o.source === 'fresh-poll' || o.source === 'reconnect-snapshot',
    );
    if (!fresh) return { last_device: null, has_recent_fresh_state: false };
    return { last_device: fresh.canonical_id, has_recent_fresh_state: true };
  }

  // ---------------------------------------------------------------------------
  // GLiNER2 -> IntentProposal conversion
  // ---------------------------------------------------------------------------

  /**
   * Convert an ExtractionResult into an IntentProposal. Returns null
   * when the extraction is incomplete (target missing, intent family
   * missing, low confidence, etc.).
   */
  private async tryGliner2ToProposal(
    extraction: ExtractionResult,
    request_id: string,
  ): Promise<IntentProposal | null> {
    if (extraction.confidence < this.gliner2_confidence_threshold) {
      return null;
    }
    if (extraction.unresolved.length > 0) return null;
    const entities = extraction.entities;
    const device_targets = entities['device_target'] ?? [];
    const rooms = entities['room'] ?? [];
    const exclusions = entities['exclusion'] ?? [];
    const times = entities['time_expression'] ?? [];
    const values = entities['value_expression'] ?? [];

    const intent_family = inferIntentFamily(extraction.classifications);
    if (intent_family === null || intent_family === 'unsupported') {
      return null;
    }

    // Routines are named values managed by Hearth, never physical device
    // targets. GLiNER may emit a routine phrase in device_target because it
    // is not a dedicated entity type, so only accept the explicit
    // value_expression for this intent.
    let resolved_targets = intent_family === 'routine-trigger'
      ? (values.length === 1 ? [...values] : null)
      : await this.expandRoomLampTargets(device_targets, rooms);
    if (resolved_targets === null) return null;
    if (resolved_targets.length === 0 && intent_family === 'set-scene' && rooms.length === 1) {
      resolved_targets = rooms;
    }
    if (resolved_targets.length === 0) return null;

    const desired_values = buildDesiredValues(intent_family, values, extraction);
    if (desired_values === null) {
      return null;
    }

    const temporal = inferTemporal(times);
    const unresolved_fields = [...extraction.unresolved];

    const provenance: ProposalProvenance = {
      source: 'gliner2',
      checkpoint_id: this.gliner2_checkpoint_id(),
      schema_version: this.gliner2_schema_version(),
    };

    return {
      request_id,
      intent_family,
      target_phrases: resolved_targets,
      exclusions,
      desired_values,
      temporal,
      unresolved_fields,
      confidence: extraction.confidence,
      provenance,
    };
  }

  /**
   * GLiNER2 may correctly identify "lamps" and a room without naming each
   * device. Expand only an exact room and only individually named lights.
   * The executor still resolves and authorizes every resulting target.
   */
  private async expandRoomLampTargets(
    device_targets: ReadonlyArray<string>,
    room_targets: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<string> | null> {
    const generic = device_targets.length > 0 && device_targets.every((target) =>
      /^(?:(?:all|every)\s+)?(?:the\s+)?(?:lamps?|lights?)$/i.test(target.trim()),
    );
    if (!generic) return device_targets;
    if (room_targets.length !== 1) return null;

    const snapshot = this.registry.snapshot?.();
    if (!snapshot) return null;
    const roomName = room_targets[0]!.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    const rooms = snapshot.rooms.filter((room) =>
      room.name.trim().toLocaleLowerCase().replace(/\s+/g, ' ') === roomName,
    );
    if (rooms.length !== 1) return null;

    const memberIds = new Set(rooms[0]!.device_ids.map(String));
    const roomLampEntityAllowlist = this.room_lamp_entity_allowlist;
    const lampTargets = snapshot.devices.filter((device) =>
      memberIds.has(String(device.canonical_id))
      && device.load_type === 'light'
      && (roomLampEntityAllowlist === undefined || device.provider_ids.some((provider) =>
        provider.kind === 'ha' && roomLampEntityAllowlist.has(provider.entity_id),
      ))
      && (device_targets.some((target) => /lamp/i.test(target))
        ? /\blamps?\b/i.test(device.friendly_name)
        : /\b(?:light|lamp)s?\b/i.test(device.friendly_name)),
    );
    const names = lampTargets.map((device) => device.friendly_name);
    if (names.length === 0 || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      return null;
    }
    return names;
  }

  /**
   * Model output is a meaning proposal, never an authority source. Before a
   * fallback can become executable, keep target names grounded in the request
   * and reject common omissions that a resolver cannot recover safely.
   */
  private async isSafeFallbackProposal(
    utterance: string,
    proposal: IntentProposal,
  ): Promise<boolean> {
    if (proposal.unresolved_fields.length > 0) return false;
    const text = normalizeForGrounding(utterance);
    if (/\b(?:except|excluding|other than|but not)\b/.test(text)
      && proposal.exclusions.length === 0) return false;

    const actions = text.match(/\b(?:turn\s+(?:on|off)|switch\s+(?:on|off)|dim|brighten|increase|decrease|set\s+(?:the\s+)?brightness)\b/g) ?? [];
    if (actions.length > 1) return false;
    if (/\b(?:turn|switch)\s+on\b/.test(text)
      && proposal.intent_family === 'set-state'
      && proposal.desired_values.on !== true && proposal.desired_values.on !== 'on') return false;
    if (/\b(?:turn|switch)\s+off\b/.test(text)
      && proposal.intent_family === 'set-state'
      && proposal.desired_values.on !== false && proposal.desired_values.on !== 'off') return false;
    if (/\b(?:dim|brighten|increase|decrease|brightness)\b/.test(text)
      && !['set-brightness-absolute', 'set-brightness-relative'].includes(proposal.intent_family)) return false;
    if (proposal.intent_family.startsWith('set-brightness')
      && !/\b(?:dim|brighten|increase|decrease|brightness|brighter|dimmer)\b/.test(text)) return false;

    for (const phrase of proposal.target_phrases) {
      const target = normalizeForGrounding(phrase);
      if (target && text.includes(target)) continue;
      const candidates = await this.registry.resolve(phrase);
      const groundedAlias = candidates.some(({ device }) =>
        device.aliases.some((alias) => {
          const normalizedAlias = normalizeForGrounding(alias);
          return normalizedAlias.length > 2 && text.includes(normalizedAlias);
        }),
      );
      if (groundedAlias) continue;

      // Permit only the explicit GLiNER2 room-lamp expansion, where the
      // utterance names the complete room and lamps, and every result is a
      // lamp in that exact room. General room-light expansion stays a
      // clarification because it can hide mixed or ambiguous loads.
      const snapshot = this.registry.snapshot?.();
      const explicitRoomLampExpansion = snapshot !== undefined
        && /\blamps\b/.test(text)
        && snapshot.rooms.some((room) => {
          const roomName = normalizeForGrounding(room.name);
          if (!roomName || !text.includes(roomName)) return false;
          const roomMembers = new Set(room.device_ids.map(String));
          const roomLamps = snapshot.devices.filter((device) =>
            roomMembers.has(String(device.canonical_id))
            && device.load_type === 'light'
            && /\blamp\b/i.test(device.friendly_name)
            && (this.room_lamp_entity_allowlist === undefined || device.provider_ids.some((provider) =>
              provider.kind === 'ha' && this.room_lamp_entity_allowlist!.has(provider.entity_id),
            )),
          );
          const resultIsRoomLamp = candidates.some(({ device }) =>
            roomMembers.has(String(device.canonical_id))
            && device.load_type === 'light'
            && /\blamp\b/i.test(device.friendly_name)
            && (this.room_lamp_entity_allowlist === undefined || device.provider_ids.some((provider) =>
              provider.kind === 'ha' && this.room_lamp_entity_allowlist!.has(provider.entity_id),
            )),
          );
          const proposedNames = proposal.target_phrases.map(normalizeForGrounding).sort();
          const completeRoomNames = roomLamps.map((device) => normalizeForGrounding(device.friendly_name)).sort();
          return resultIsRoomLamp && completeRoomNames.length > 0
            && proposedNames.length === completeRoomNames.length
            && proposedNames.every((name, index) => name === completeRoomNames[index]);
        });
      if (!explicitRoomLampExpansion) return false;
    }
    return true;
  }

  private gliner2_checkpoint_id(): string {
    // The provider is optional and we don't block on its health here.
    // Use a stable default; the resolver can re-validate later.
    return 'gliner2-adhoc';
  }

  private gliner2_schema_version(): string {
    return '1';
  }

  // ---------------------------------------------------------------------------
  // Proposal context (for Bonsai)
  // ---------------------------------------------------------------------------

  private buildProposalContext(): ProposalContext {
    const snap = this.registry.snapshot?.();
    const devices: ReadonlyArray<DeviceRecord> = snap?.devices ?? [];
    const rooms: ReadonlyArray<GrammarRegistrySnapshot['rooms'][number]> = snap?.rooms ?? [];
    const roomById = new Map<string, GrammarRegistrySnapshot['rooms'][number]>(
      rooms.map((r) => [String(r.room_id), r]),
    );
    const known_devices = devices.map((d: DeviceRecord) => ({
      canonical_id: d.canonical_id,
      friendly_name: d.friendly_name,
      aliases: d.aliases,
      room_name: d.room_id ? (roomById.get(String(d.room_id))?.name ?? null) : null,
    }));
    return {
      known_devices,
      known_scenes: [],
      recent_fresh_state: this.recent_fresh_state(),
    };
  }
}

function normalizeForGrounding(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// =============================================================================
// Helpers
// =============================================================================

function rejectForbiddenFields(payload: Record<string, unknown>): void {
  const found: string[] = [];
  for (const f of FORBIDDEN_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, f)) {
      found.push(f);
    }
  }
  if (found.length > 0) {
    throw new ForbiddenFieldError(
      `request body contains forbidden server-derived fields: ${found.join(', ')}`,
      found,
    );
  }
}

/**
 * Compose a Bonsai proposal with a GLiNER2 partial extraction. The
 * resulting proposal carries provenance.source='composed-gliner2-bonsai'
 * so callers can see both layers contributed. Fields the Bonsai proposal
 * filled out are kept; the GLiNER2 partial is only used for the
 * provenance and (optionally) as a confidence boost.
 */
function composeProvenance(
  bonsai_proposal: IntentProposal,
  extraction: ExtractionResult,
): IntentProposal {
  // We need a bonsai adapter id and a gliner2 checkpoint id. The mock
  // extraction result doesn't carry the checkpoint id; in real life the
  // adapter is the source of truth. We capture the checkpoint id from
  // the running ExtractionProvider via the interpreter instance.
  // For now, fall back to 'gliner2-adhoc' which matches the interpreter's
  // default. The composed provenance reflects both layers.
  return {
    ...bonsai_proposal,
    provenance: {
      source: 'composed-gliner2-bonsai',
      gliner2_checkpoint_id: 'gliner2-adhoc',
      bonsai_adapter_id:
        bonsai_proposal.provenance.source === 'bonsai'
          ? bonsai_proposal.provenance.adapter_id
          : 'unknown-bonsai-adapter',
    },
    // Bonsai receives the full utterance and can resolve a GLiNER2 gap.
    // Keep unresolved fields only when the composed proposal still lacks
    // the corresponding information. Exclusions stay unresolved unless
    // Bonsai explicitly returned at least one exclusion.
    unresolved_fields: Array.from(new Set([
      ...bonsai_proposal.unresolved_fields,
      ...extraction.unresolved.filter((field) => !proposalSatisfiesField(bonsai_proposal, field)),
    ])),
  };
}

function proposalSatisfiesField(proposal: IntentProposal, field: string): boolean {
  switch (field) {
    case 'intent':
      return proposal.intent_family !== 'unsupported';
    case 'device_target':
    case 'room':
    case 'group':
      return proposal.target_phrases.length > 0;
    case 'exclusion':
      return proposal.exclusions.length > 0;
    case 'time_expression':
      return proposal.temporal !== null || typeof proposal.desired_values['until'] === 'string';
    case 'value_expression':
      switch (proposal.intent_family) {
        case 'set-brightness-absolute':
        case 'set-brightness-relative':
          return typeof proposal.desired_values['brightness'] === 'number'
            || typeof proposal.desired_values['brightness_delta'] === 'number';
        case 'set-scene':
          return typeof proposal.desired_values['scene_id'] === 'string';
        case 'hold-until':
          return typeof proposal.desired_values['until'] === 'string';
        case 'routine-trigger':
          return typeof proposal.desired_values['routine_name'] === 'string';
        default:
          return true;
      }
    default:
      return false;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function inferIntentFamily(
  classifications: ReadonlyArray<{ readonly label: ExtractionLabel; readonly span: string }>,
): IntentFamily | null {
  // Map GLiNER2 classification labels to IntentFamily. The first label
  // wins when multiple are present. We deliberately do not coerce an
  // unsupported family silently; the caller (resolver) handles clarify.
  for (const c of classifications) {
    switch (c.label) {
      case 'on':
      case 'off':
        return 'set-state';
      case 'set_brightness':
        return 'set-brightness-absolute';
      case 'dim_by':
        return 'set-brightness-relative';
      case 'set_scene':
        return 'set-scene';
      case 'hold_until':
        return 'hold-until';
      case 'routine_trigger':
        return 'routine-trigger';
      case 'query_state':
        return 'query-state';
    }
  }
  return null;
}

function buildDesiredValues(
  family: IntentFamily,
  values: ReadonlyArray<string>,
  extraction: ExtractionResult,
): Readonly<Record<string, number | string | boolean>> | null {
  switch (family) {
    case 'set-state':
      // Default on=true unless "off" appears in classifications or values.
      {
        const off = extraction.classifications.some((c) => c.label === 'off');
        return { on: !off };
      }
    case 'set-brightness-absolute': {
      const n = extractNumber(values);
      if (n === null) return null;
      return { brightness: n };
    }
    case 'set-brightness-relative': {
      // GLiNER2 emits the size of a dim operation, while the executor
      // contract represents dimming as a negative brightness delta.
      const n = extractNumber(values);
      if (n === null) return null;
      return { brightness_delta: extraction.classifications.some((c) => c.label === 'dim_by') ? -Math.abs(n) : n };
    }
    case 'set-scene':
      // Scene name should appear in values. Without it, escalate.
      if (values.length === 0) return null;
      return { scene_id: values[0]! };
    case 'hold-until': {
      const time = extraction.entities['time_expression']?.[0] ?? values[0];
      if (time === undefined) return null;
      return { until: time };
    }
    case 'routine-trigger':
      if (values.length === 0) return null;
      return { routine_name: values[0]! };
    case 'query-state':
      return {};
    case 'unsupported':
      return null;
  }
}

function extractNumber(values: ReadonlyArray<string>): number | null {
  for (const v of values) {
    const m = /(-?\d+(?:\.\d+)?)/.exec(v);
    if (m && m[1] !== undefined) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function inferTemporal(times: ReadonlyArray<string>): TemporalClause | null {
  if (times.length === 0) return null;
  const t = times[0]!.toLowerCase();
  if (t === 'midnight') {
    return { kind: 'until', iso: '00:00', restore_behavior: 'restore-previous' };
  }
  if (t === 'sunrise') return { kind: 'after-sunrise' };
  if (t === 'sunset') return { kind: 'after-sunset' };
  const m = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)$/.exec(t);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    const n = Number(m[1]);
    const unit = m[2];
    let s = 0;
    if (unit.startsWith('s')) s = n;
    else if (unit.startsWith('m')) s = n * 60;
    else if (unit.startsWith('h')) s = n * 3600;
    if (s > 0) return { kind: 'for-duration', seconds: s, restore_behavior: 'restore-previous' };
  }
  return null;
}

// Silence "unused type" lints - exported for downstream consumers.
export type { ProviderId };
export type _ServerDerivedRole = ActorRole;
export type _ServerDerivedCanonicalId = CanonicalId;
export type _ServerDerivedLoadType = LoadType;
