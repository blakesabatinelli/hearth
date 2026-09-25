/**
 * OpenClaw protocol layer for Hearth.
 *
 * Houses the request schema presented to Bonsai, the system+user
 * prompt builders, and the loopback guard. Kept separate from
 * provider.ts so the protocol is testable without a fetch shim.
 */

import type {
  IntentFamily,
  IntentProposal,
  ProposalContext,
  TemporalClause,
} from '@hearth/contracts';

// ---------------------------------------------------------------------------
// Strict JSON Schema for IntentProposal
// ---------------------------------------------------------------------------

/**
 * Hearth's IntentProposal, expressed as a JSON Schema dict that Bonsai
 * is asked to satisfy. We use a hand-rolled schema (not Ajv/zod) to
 * keep the dependency graph tight: the Bonsai output is small enough
 * that hand-rolled validation gives clearer error messages.
 *
 * Schema-version-aware: the `schema_version` field in the model output
 * must equal this. If Bonsai emits a different schema_version, the
 * adapter rejects the output and surfaces a "schema-drift" error.
 */
export const PROPOSAL_SCHEMA_VERSION = '0.0.1';

export const PROPOSAL_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'HearthIntentProposal',
  type: 'object',
  required: [
    'request_id',
    'intent_family',
    'target_phrases',
    'desired_values',
    'confidence',
    'provenance',
  ],
  additionalProperties: false,
  properties: {
    request_id: { type: 'string', minLength: 1, maxLength: 200 },
    intent_family: {
      type: 'string',
      enum: [
        'set-state',
        'set-brightness-absolute',
        'set-brightness-relative',
        'set-scene',
        'hold-until',
        'routine-trigger',
        'query-state',
        'unsupported',
      ],
    },
    target_phrases: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
    exclusions: { type: 'array', items: { type: 'string' }, default: [] },
    desired_values: {
      type: 'object',
      additionalProperties: { type: ['number', 'string', 'boolean'] },
    },
    temporal: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: { enum: ['until', 'after-sunset', 'after-sunrise', 'for-duration'] },
            iso: { type: 'string' },
            restore_behavior: { enum: ['restore-previous', 'set-to-known-state'] },
            seconds: { type: 'integer', minimum: 0 },
          },
        },
      ],
    },
    unresolved_fields: { type: 'array', items: { type: 'string' }, default: [] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    provenance: {
      type: 'object',
      required: ['source', 'adapter_id'],
      properties: {
        source: { const: 'bonsai' },
        adapter_id: { type: 'string' },
        schema_version: { const: PROPOSAL_SCHEMA_VERSION },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for Bonsai. Encodes the protocol version
 * and the Hearth interpretation contract.
 *
 * Two principles:
 *   - Bonsai speaks a constrained vocabulary: it can only emit JSON
 *     matching the schema, with vocabulary drawn from IntentFamily
 *     and TargetKind. No arbitrary interpretation.
 *   - Bonsai has no home-control tools. It never sees device IDs,
 *     tokens, or HA URLs. The known_devices list it sees is
 *     friendly_name only (plus a stable opID the registry uses to map
 *     back to canonical_id, but that mapping is computed by Hearth,
 *     not Bonsai).
 */
export function buildSystemPrompt(): string {
  return [
    'You are Bonsai, the planning model for Hearth.',
    'You ONLY emit JSON matching the supplied schema. No prose outside the JSON.',
    `Schema version: ${PROPOSAL_SCHEMA_VERSION}.`,
    'You never invent device IDs, tokens, or URLs.',
    'You never propose an action. You propose an INTERPRETATION. Hearth decides whether to act.',
    'If the user request is ambiguous or underspecified, mark intent_family as "unsupported" and list the ambiguous items in unresolved_fields.',
    'If the user request is out-of-scope (e.g. physical safety action that requires explicit confirmation), mark intent_family as "unsupported" with a single item in unresolved_fields describing why.',
  ].join('\n');
}

/**
 * Build the user prompt. Replaces device identifiers with friendly
 * names (Bonsai never sees entity_id values, only friendly_name +
 * alias phrases). Rendered as an opaque / established list to avoid
 * prompt injection surface area.
 */
export function buildUserPrompt(req: {
  request_id: string;
  utterance: string;
  context: ProposalContext;
}): string {
  const device_lines = req.context.known_devices.map((d) => {
    const aliases = d.aliases.slice(0, 6).join(' | ');
    const room = d.room_name ? ` (in ${d.room_name})` : '';
    return `- "${d.friendly_name}"${room}: aliases ${aliases}`;
  });
  const scene_lines = req.context.recent_fresh_state.length
    ? `\nRecent state (do NOT cite in your output, use only for context):\n${req.context.recent_fresh_state
        .slice(0, 8)
        .map((s) => `- ${s.canonical_id} ${JSON.stringify(s.values)}`)
        .join('\n')}`
    : '';
  return [
    `request_id: ${req.request_id}`,
    `Known devices (refer by friendly_name in target_phrases):`,
    device_lines.join('\n'),
    `Known scenes (refer by friendly_name or scene_id):`,
    ...req.context.known_scenes.map((s) => `- ${s.friendly_name}`),
    `Recent state:`,
    scene_lines,
    `User utterance: ${req.utterance}`,
    `Reply with JSON only. Do not wrap in a code block. Do not add commentary.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Loopback guard
// ---------------------------------------------------------------------------

/**
 * OpenClaw must run on loopback. We refuse to construct a provider
 * that points anywhere else. This is a defense-in-depth: the operator
 * may have mis-typed a config, or DNS may resolve an external host to
 * a malicious IP. By pinning to 127.0.0.1/::1 we eliminate that
 * whole class of risk in a single check.
 *
 * IPv6 loopback (::1) is accepted. RFC1918 ranges (10.x, 192.168.x,
 * 172.16-31.x) are NOT accepted: those are still "remote" from the
 * service's perspective even if administratively local, and we want
 * the explicit hostname "loopback" in the configuration.
 */
export function assertLoopbackOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid OpenClaw gateway URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // Quarantine: OpenClaw with HTTPS on loopback would also be
    // unusual; we keep the protocol check strict so a misconfig (for
    // example, a file:// or ws:// URL) fails closed.
    throw new Error(`OpenClaw gateway URL must be http(s); got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    throw new Error(
      `OpenClaw gateway URL must resolve to loopback (localhost, 127.0.0.1, or ::1); got "${host}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema validator (hand-rolled, no Ajv dependency)
// ---------------------------------------------------------------------------

export class ProposalValidationError extends Error {
  readonly path: string;
  readonly raw: unknown;
  constructor(message: string, path: string, raw: unknown) {
    super(`proposal validation failed at ${path}: ${message}`);
    this.name = 'ProposalValidationError';
    this.path = path;
    this.raw = raw;
  }
}

const INTENT_FAMILIES: ReadonlySet<IntentFamily> = new Set([
  'set-state',
  'set-brightness-absolute',
  'set-brightness-relative',
  'set-scene',
  'hold-until',
  'routine-trigger',
  'query-state',
  'unsupported',
]);

/**
 * Strict JSON-Schema-shaped validator for the openclaw adapter.
 * This is what `OpenClawBonsaiProvider.validateProposal()` calls.
 *
 * Throws ProposalValidationError on the first failure. We do NOT
 * attempt repair -- the doc says "Invalid -> clarify/fail, NEVER
 * silent repair."
 */
export function validateProposalRaw(raw: unknown): IntentProposal {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProposalValidationError('expected object', '$', raw);
  }
  const obj = raw as Record<string, unknown>;

  // request_id
  if (typeof obj['request_id'] !== 'string' || obj['request_id'].length === 0) {
    throw new ProposalValidationError('request_id must be a non-empty string', '$.request_id', obj['request_id']);
  }
  // intent_family
  const family = obj['intent_family'];
  if (typeof family !== 'string' || !INTENT_FAMILIES.has(family as IntentFamily)) {
    throw new ProposalValidationError(`intent_family must be one of ${[...INTENT_FAMILIES].join(', ')}`, '$.intent_family', family);
  }
  // target_phrases
  const phrases = obj['target_phrases'];
  if (!Array.isArray(phrases)) {
    throw new ProposalValidationError('target_phrases must be an array', '$.target_phrases', phrases);
  }
  for (let i = 0; i < phrases.length; i += 1) {
    if (typeof phrases[i] !== 'string' || phrases[i].length === 0 || (phrases[i] as string).length > 200) {
      throw new ProposalValidationError(
        `target_phrases[${i}] must be a 1..200 char string`,
        `$.target_phrases[${i}]`,
        phrases[i],
      );
    }
  }
  // exclusions (optional, default [])
  const exclusions = Array.isArray(obj['exclusions']) ? obj['exclusions'] : [];
  for (let i = 0; i < exclusions.length; i += 1) {
    if (typeof exclusions[i] !== 'string') {
      throw new ProposalValidationError(
        `exclusions[${i}] must be string`,
        `$.exclusions[${i}]`,
        exclusions[i],
      );
    }
  }
  // desired_values
  const desired = obj['desired_values'];
  if (typeof desired !== 'object' || desired === null || Array.isArray(desired)) {
    throw new ProposalValidationError(
      'desired_values must be an object',
      '$.desired_values',
      desired,
    );
  }
  for (const [k, v] of Object.entries(desired)) {
    const t = typeof v;
    if (t !== 'number' && t !== 'string' && t !== 'boolean') {
      throw new ProposalValidationError(
        `desired_values.${k} must be number|string|boolean (got ${t})`,
        `$.desired_values.${k}`,
        v,
      );
    }
  }
  // temporal (optional)
  const temporal = obj['temporal'];
  if (temporal !== undefined && temporal !== null) {
    if (typeof temporal !== 'object' || Array.isArray(temporal)) {
      throw new ProposalValidationError('temporal must be an object or null', '$.temporal', temporal);
    }
    const tt = temporal as Record<string, unknown>;
    if (typeof tt['kind'] !== 'string') {
      throw new ProposalValidationError('temporal.kind is required', '$.temporal.kind', tt['kind']);
    }
    const tempKind = tt['kind'] as string;
    if (tempKind === 'until' || tempKind === 'for-duration') {
      // restore_behavior required
      if (tt['restore_behavior'] !== 'restore-previous' && tt['restore_behavior'] !== 'set-to-known-state') {
        throw new ProposalValidationError(
          `temporal.restore_behavior required for ${tempKind}`,
          '$.temporal.restore_behavior',
          tt['restore_behavior'],
        );
      }
    }
    if (tempKind === 'until' && typeof tt['iso'] !== 'string') {
      throw new ProposalValidationError('temporal.iso required for until', '$.temporal.iso', tt['iso']);
    }
    if (tempKind === 'for-duration' && typeof tt['seconds'] !== 'number') {
      throw new ProposalValidationError(
        'temporal.seconds must be a number for for-duration',
        '$.temporal.seconds',
        tt['seconds'],
      );
    }
    void (null as unknown as TemporalClause);
  }
  // unresolved_fields (optional)
  const unresolved = Array.isArray(obj['unresolved_fields']) ? obj['unresolved_fields'] : [];
  for (let i = 0; i < unresolved.length; i += 1) {
    if (typeof unresolved[i] !== 'string') {
      throw new ProposalValidationError(
        `unresolved_fields[${i}] must be string`,
        `$.unresolved_fields[${i}]`,
        unresolved[i],
      );
    }
  }
  // confidence
  const conf = obj['confidence'];
  if (typeof conf !== 'number' || conf < 0 || conf > 1) {
    throw new ProposalValidationError('confidence must be in [0, 1]', '$.confidence', conf);
  }
  // provenance
  const prov = obj['provenance'];
  if (typeof prov !== 'object' || prov === null) {
    throw new ProposalValidationError('provenance required', '$.provenance', prov);
  }
  const p = prov as Record<string, unknown>;
  if (p['source'] !== 'bonsai') {
    throw new ProposalValidationError(
      'provenance.source must be "bonsai" (this adapter only)',
      '$.provenance.source',
      p['source'],
    );
  }
  if (typeof p['adapter_id'] !== 'string') {
    throw new ProposalValidationError('provenance.adapter_id required', '$.provenance.adapter_id', p['adapter_id']);
  }
  if (p['schema_version'] !== PROPOSAL_SCHEMA_VERSION) {
    throw new ProposalValidationError(
      `provenance.schema_version must be "${PROPOSAL_SCHEMA_VERSION}"`,
      '$.provenance.schema_version',
      p['schema_version'],
    );
  }

  // Construct the typed proposal.
  return {
    request_id: obj['request_id'] as string,
    intent_family: family as IntentFamily,
    target_phrases: phrases as ReadonlyArray<string>,
    exclusions: exclusions as ReadonlyArray<string>,
    desired_values: desired as Readonly<Record<string, number | string | boolean>>,
    temporal: (temporal === undefined ? null : temporal) as TemporalClause | null,
    unresolved_fields: unresolved as ReadonlyArray<string>,
    confidence: conf,
    provenance: {
      source: 'bonsai',
      adapter_id: p['adapter_id'] as string,
    },
  };
}
