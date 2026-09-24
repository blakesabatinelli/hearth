/**
 * @hearth/contracts
 *
 * Shared types for Hearth. Imported by every other package. This is the
 * single source of truth for the contract schema, the receipt shape, the
 * intent-proposal schema, the device/registry types, and the execution
 * outcome taxonomy.
 *
 * Plan refs: section 4 architecture, section 6 identity, section 7
 * interpretation contract, section 8 executor + evidence, section 9
 * scheduling.
 *
 * Hard rule: types in this file must be expressive enough to make model-
 * supplied authority fields unrepresentable. No `actor_id`/`role`/`policy`
 * fields come from the model or the client; the server derives them.
 */

// =============================================================================
// Identity: actors and principals
// =============================================================================

/**
 * Authenticated principal. Derived server-side from the session cookie.
 * Never comes from request payload. Re-derived immediately before every
 * dispatch (plan section 8).
 */
export type Actor = {
  readonly actor_id: string;
  readonly role: ActorRole;
  readonly session_id: string;
};

export type ActorRole =
  | 'admin'        // full control, can edit registry/scenes/routines
  | 'member'       // routine household control within Hearth permissions
  | 'wall-tablet'  // limited principal: favorites + rooms only, no routines
  | 'service';     // internal: routines scheduler, recovery, etc.

/**
 * Canonical device ID. Provider identifiers map to one of these. Multiple
 * provider IDs can map to the same canonical ID if they control the same
 * physical load (plan section 6). Renames or removals of provider IDs do
 * NOT automatically transfer authority.
 */
export type CanonicalId = string & { readonly __brand: 'CanonicalId' };

// =============================================================================
// Registry overlay
// =============================================================================

export type LoadType =
  | 'light'
  | 'unknown-switch'   // not assumed to be lighting (plan section 3 Deferred)
  | 'outlet'
  | 'fan'
  | 'blind'            // future: not in scope Stage 1
  | 'lock'             // future: not in scope Stage 1
  | 'media'            // future: not in scope Stage 1
  | 'other';

export type Capability =
  | 'on-off'
  | 'brightness'
  | 'color-temperature'
  | 'color-rgb'
  | 'scene';

export type ProviderId =
  | { readonly kind: 'ha'; readonly entity_id: string }
  | { readonly kind: 'hue'; readonly hue_id: string }
  | { readonly kind: 'smartthings'; readonly device_id: string }
  | { readonly kind: 'alexa'; readonly device_id: string }
  | { readonly kind: 'mqtt'; readonly topic: string }
  | { readonly kind: 'matter'; readonly node_id: string };

export type RoutePreference =
  | 'local-first'   // prefer LAN/local integrations; fall back to cloud
  | 'cloud-first'   // prefer cloud (e.g. SmartThings paid); reconcile with local
  | 'ha-only';      // only route is via Home Assistant

export type DeviceRecord = {
  readonly canonical_id: CanonicalId;
  readonly friendly_name: string;
  readonly load_type: LoadType;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly aliases: ReadonlyArray<string>;
  readonly provider_ids: ReadonlyArray<ProviderId>;
  readonly room_id: RoomId | null;
  readonly allowed_actors: ReadonlyArray<ActorRole>;
  readonly route_preference: RoutePreference;
  readonly version: number;  // bumped on every overlay edit
};

export type RoomId = string & { readonly __brand: 'RoomId' };

export type Room = {
  readonly room_id: RoomId;
  readonly name: string;
  readonly device_ids: ReadonlyArray<CanonicalId>;
};

// =============================================================================
// Intent proposal (model output)
// =============================================================================

/**
 * A structured proposal produced by either the GLiNER2 extraction path,
 * the deterministic grammar parser, or Bonsai fallback. This is the *only*
 * shape those layers are allowed to emit. Server-side validation runs
 * again, then the resolver turns this into a Contract.
 *
 * Plan section 7: model output is untrusted input to the resolver, even
 * when syntactically valid. Malformed/unsupported output causes
 * clarification or failure, never silent repair into an action.
 *
 * NOTE: there is no `actor_id`/`role`/`policy`/`expiry`/`allowed_devices`
 * field here. Those are server-derived. The proposal binds to the active
 * request record via `request_id`.
 *
 * The `provenance` field records which layer emitted the proposal. The
 * executor uses this for routing and metrics; it does NOT grant any
 * authority (plan section 7 + ADR-2026-09-24-gliner2-required).
 */
export type IntentProposal = {
  readonly request_id: string;          // opaque server-side request record id
  readonly intent_family: IntentFamily;
  readonly target_phrases: ReadonlyArray<string>;  // not yet resolved to canonical IDs
  readonly exclusions: ReadonlyArray<string>;        // never silently dropped (plan section 13 Stage 3 gate)
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly temporal: TemporalClause | null;
  readonly unresolved_fields: ReadonlyArray<string>;
  readonly confidence: number;          // 0..1, advisory only, server may override
  readonly provenance: ProposalProvenance;
};

export type ProposalProvenance =
  | { readonly source: 'grammar'; readonly matched_rule: string }
  | { readonly source: 'gliner2'; readonly checkpoint_id: string; readonly schema_version: string }
  | { readonly source: 'bonsai'; readonly adapter_id: string }
  | { readonly source: 'composed-gliner2-bonsai'; readonly gliner2_checkpoint_id: string; readonly bonsai_adapter_id: string };

export type IntentFamily =
  | 'set-state'
  | 'set-brightness-absolute'
  | 'set-brightness-relative'   // "by" 10 percent, not "to" 10 percent
  | 'set-scene'
  | 'hold-until'               // "until midnight"
  | 'routine-trigger'          // name a routine
  | 'query-state'
  | 'unsupported';             // must clarify or fail, never silently coerce

export type TemporalClause =
  | { readonly kind: 'until'; readonly iso: string; readonly restore_behavior: 'restore-previous' | 'set-to-known-state' }
  | { readonly kind: 'after-sunset' }
  | { readonly kind: 'after-sunrise' }
  | { readonly kind: 'for-duration'; readonly seconds: number; readonly restore_behavior: 'restore-previous' | 'set-to-known-state' };

// =============================================================================
// Contract (server-generated, authoritative)
// =============================================================================

/**
 * Authoritative contract (plan section 8). Persisted before dispatch. The
 * client never supplies authoritative role/policy fields. The server
 * generates the contract from a proposal + the actor + current registry
 * version. Idempotency, expiry, supersede are enforced here.
 */
export type Contract = {
  readonly contract_id: string;
  readonly actor: Actor;                                     // server-derived
  readonly request_id: string;                               // client-supplied idempotency key
  readonly intent_family: IntentFamily;
  readonly targets: ReadonlyArray<ContractTarget>;
  readonly exclusions: ReadonlyArray<string>;                // absolute names; verifier checks
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly entity_version: number;                           // registry version snapshot
  readonly scene_version: number | null;                     // if intent is set-scene
  readonly preconditions: ReadonlyArray<Precondition>;
  readonly expiry_at: string;                                // ISO8601 UTC
  readonly allowed_routes: ReadonlyArray<RoutePreference>;
  readonly per_target_evidence: Readonly<Record<CanonicalId, EvidencePolicy>>;
  readonly status: ContractStatus;
  readonly created_at: string;                               // ISO8601 UTC
};

export type ContractTarget = {
  readonly canonical_id: CanonicalId;
  readonly load_type: LoadType;
  readonly route: RoutePreference;
  readonly state_version: number;                        // pre-dispatch; checked again at dispatch
};

export type Precondition =
  | { readonly kind: 'state-equals'; readonly canonical_id: CanonicalId; readonly field: string; readonly value: number | string | boolean }
  | { readonly kind: 'within-version'; readonly canonical_id: CanonicalId; readonly version: number };

export type EvidencePolicy = {
  readonly require_fresh_observation_ms: number;       // null/0 = accept transport ack as minimum
  readonly accept_optimistic: boolean;                 // cached echo only
  readonly on_unsupported: 'fail' | 'partial' | 'silent-noop';
};

export type ContractStatus =
  | 'pending'     // accepted, not yet dispatched
  | 'dispatching' // executor has it
  | 'confirmed'   // every target satisfied per evidence policy
  | 'partial'     // some targets confirmed, others failed/uncertain
  | 'sent-unconfirmed' // command sent, evidence not yet returned
  | 'failed'      // dispatch failed; retry decision per policy
  | 'cancelled'   // user cancelled before dispatch
  | 'expired'     // past expiry_at; not retried
  | 'superseded'  // newer contract replaced it
  | 'no-op';      // already-satisfied; no dispatch required

// =============================================================================
// Receipts (per-target + aggregate)
// =============================================================================

/**
 * Per-target outcome (plan section 8 lifecycle).
 *
 * Already-satisfied: a fresh observation already matches the goal.
 * Observed-after-command: a trustworthy fresh report matches the goal.
 * Optimistic-or-cached-only: transport ack or state echo, no real poll.
 * Unknown-after-failure: command may have executed; verification was lost.
 */
export type TargetOutcome =
  | { readonly kind: 'already-satisfied'; readonly observed_at: string }
  | { readonly kind: 'observed-after-command'; readonly observed_at: string; readonly state_version: number }
  | { readonly kind: 'optimistic-only'; readonly echoed_at: string }
  | { readonly kind: 'unknown-after-failure'; readonly last_known_state: unknown }
  | { readonly kind: 'failed'; readonly error: DispatchError };

export type DispatchError =
  | { readonly code: 'unauthorized'; readonly message: string }
  | { readonly code: 'route-unavailable'; readonly route: RoutePreference; readonly message: string }
  | { readonly code: 'precondition-failed'; readonly canonical_id: CanonicalId }
  | { readonly code: 'scene-scope-uncertain'; readonly message: string }
  | { readonly code: 'timeout'; readonly route: RoutePreference; readonly ms: number }
  | { readonly code: 'provider-error'; readonly provider: string; readonly message: string };

export type Receipt = {
  readonly receipt_id: string;
  readonly contract_id: string;
  readonly actor: Actor;
  readonly per_target: Readonly<Record<CanonicalId, TargetOutcome>>;
  readonly aggregate: ContractStatus;          // derived from per_target
  readonly created_at: string;
  readonly incident: IncidentRecord | null;
};

export type IncidentRecord =
  | { readonly kind: 'wrong-target'; readonly canonical_id: CanonicalId; readonly reported_by: string; readonly paused_until: string | null }
  | { readonly kind: 'invariant-violation'; readonly detail: string; readonly paused_categories: ReadonlyArray<IntentFamily> };

// =============================================================================
// Adapter contract (the keystone interface)
// =============================================================================

/**
 * Adapter contract for Home Assistant (real or fake). The fake-HA adapter
 * implements this exactly; real-HA is a config switch, not a code change
 * (plan section 13 Stage 1 gate).
 */
export interface HomeAssistantAdapter {
  /**
   * List devices and their canonical metadata. Returns HA entities mapped
   * to Hearth canonical IDs (provider kind: 'ha').
   */
  listDevices(): Promise<ReadonlyArray<DeviceRecord>>;

  /**
   * List rooms (HA areas).
   */
  listRooms(): Promise<ReadonlyArray<Room>>;

  /**
   * Get current state for a canonical device. The fake-HA returns the
   * last in-memory value. Real-HA performs a state call.
   *
   * IMPORTANT: plan section 8 - reading a HA snapshot after reconnect does
   * NOT inherently mean the physical device was just polled. The fake-HA
   * tracks this distinction via `source`.
   */
  getState(canonical_id: CanonicalId): Promise<StateObservation>;

  /**
   * Dispatch a single target's intent. Returns the immediate transport
   * ack; the receipt's per_target outcome is finalized by the evidence
   * watcher, not by this call.
   */
  dispatch(target: ContractTarget, desired_values: Readonly<Record<string, number | string | boolean>>): Promise<DispatchAck>;

  /**
   * Subscribe to state events. Used to register watchers BEFORE dispatch
   * (plan section 8) so a fast state event is not missed.
   */
  subscribe(canonical_ids: ReadonlyArray<CanonicalId>, handler: StateHandler): UnsubscribeableSubscription;
}

export type StateObservation = {
  readonly canonical_id: CanonicalId;
  readonly observed_at: string;            // timestamp on the source
  readonly source: 'fresh-poll' | 'cached' | 'reconnect-snapshot' | 'unknown';
  readonly values: Readonly<Record<string, number | string | boolean>>;
  readonly state_version: number;
};

export type DispatchAck =
  | { readonly kind: 'sent'; readonly provider: string; readonly echoed_at: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export type StateHandler = (obs: StateObservation) => void;
export type UnsubscribeableSubscription = { unsubscribe(): void };

// =============================================================================
// Bonsai / interpretation
// =============================================================================

/**
 * Gated behind the BonsaiProvider interface. Plan section 7: model is
 * untrusted input to the resolver. mock-bonsai for tests/CI; real-bonsai
 * when weights + serving runtime are available.
 */
export interface BonsaiProvider {
  propose(req: { request_id: string; utterance: string; context: ProposalContext }): Promise<IntentProposal>;
  /**
   * Server-side schema validation. The model returns structured JSON; the
   * provider MUST validate it. Invalid output -> clarify/fail, never
   * silent repair (plan section 7).
   */
  validateProposal(raw: unknown): IntentProposal;
}

/**
 * GLiNER2 extraction provider. ADR-2026-09-24-gliner2-required: GLiNER2
 * is the FIRST model used for natural-language requests, not Bonsai. The
 * grammar parser runs first (cheapest); if it cannot produce a complete,
 * validated interpretation, GLiNER2 runs; only if that fails AND the
 * request clearly requires contextual reasoning does Bonsai get called.
 *
 * The provider is untrusted input on output. The resolver still owns
 * authority: identity, permissions, target scope, evidence.
 *
 * Implementation note: GLiNER2 is a Python library (Apache-2.0,
 * fastino-ai/GLiNER2). The provider here is an HTTP/socket client; the
 * actual model runs in a separate `hearth-extract` Python sidecar. This
 * keeps each layer's runtime separate per plan section 4 ("the boxes
 * for parser, executor and scheduler are modules of the independent
 * control service" - GLiNER2 is explicitly outside that).
 */
export interface ExtractionProvider {
  /**
   * Extract entities, classifications, structured records, relations, and
   * span attributes from a natural-language utterance given a schema.
   * The schema is derived from the registered devices, scenes, and
   * command categories.
   *
   * Returns a structured ExtractionResult. The provider MUST reject
   * inputs that cannot be made safe (silently dropping a clause is not
   * allowed; the resolver must see "unresolved").
   */
  extract(req: { request_id: string; utterance: string; schema: ExtractionSchema }): Promise<ExtractionResult>;

  /**
   * Health check. Returns true only if the model is loaded and ready
   * to serve. Used by hearth-control's doctor and by the routing layer
   * to decide whether the GLiNER2 path is available.
   */
  health(): Promise<{ ready: boolean; checkpoint_id: string; latency_ms_p50: number | null }>;
}

/**
 * Schema passed to GLiNER2. Built from the registry + active command
 * categories. GLiNER2 is schema-driven: passing a tight schema is what
 * makes the extraction fast and accurate.
 */
export type ExtractionSchema = {
  readonly schema_version: string;
  readonly entity_types: ReadonlyArray<ExtractionEntityType>;
  readonly classification_labels: ReadonlyArray<ExtractionLabel>;
  readonly relations: ReadonlyArray<ExtractionRelation>;
  readonly known_aliases: ReadonlyArray<{ canonical_id: CanonicalId; aliases: ReadonlyArray<string> }>;
};

export type ExtractionEntityType =
  | 'device_target'
  | 'room'
  | 'group'
  | 'exclusion'
  | 'time_expression'
  | 'value_expression';

export type ExtractionLabel =
  | 'on'
  | 'off'
  | 'set_brightness'
  | 'dim_by'
  | 'set_scene'
  | 'hold_until'
  | 'routine_trigger'
  | 'query_state';

export type ExtractionRelation =
  | { readonly kind: 'target_of'; readonly from: ExtractionEntityType; readonly to: ExtractionEntityType }
  | { readonly kind: 'modifies'; readonly from: ExtractionLabel; readonly to: 'value_expression' | 'time_expression' };

export type ExtractionResult = {
  readonly request_id: string;
  readonly entities: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly classifications: ReadonlyArray<{ readonly label: ExtractionLabel; readonly span: string }>;
  readonly relations: ReadonlyArray<{ readonly kind: string; readonly head: string; readonly tail: string }>;
  readonly unresolved: ReadonlyArray<string>;
  readonly confidence: number;
  /**
   * The original utterance, preserved verbatim. Pass-through required by
   * ADR-2026-09-24-gliner2-required point 3: when the extraction path is
   * incomplete, the full utterance (NOT just extracted fields) is passed to
   * Bonsai so context is not silently dropped.
   */
  readonly original_utterance: string;
};

/**
 * Routing decision made by the interpreter after running grammar +
 * GLiNER2 (and possibly Bonsai). One of five outcomes.
 *
 * - ready_for_contract:        all required fields resolved; pass to executor
 * - needs_gliner2:             grammar failed; call GLiNER2 next
 * - needs_bonsai:              GLiNER2 incomplete AND contextual reasoning needed
 * - needs_clarification:       multi-interpretation or missing required field
 * - unsupported:               command category not in the supported set
 *
 * ADR-2026-09-24-gliner2-required point 4: when genuinely ambiguous,
 * ask the user, do NOT ask another model to guess.
 */
export type RoutingDecision =
  | { readonly outcome: 'ready_for_contract'; readonly proposal: IntentProposal }
  | { readonly outcome: 'needs_gliner2'; readonly reason: string; readonly utterance: string }
  | { readonly outcome: 'needs_bonsai'; readonly reason: string; readonly utterance: string; readonly gliner2_partial: ExtractionResult | null }
  | { readonly outcome: 'needs_clarification'; readonly reason: string; readonly candidates: ReadonlyArray<IntentProposal> }
  | { readonly outcome: 'unsupported'; readonly reason: string };

export type ProposalContext = {
  readonly known_devices: ReadonlyArray<{ canonical_id: CanonicalId; friendly_name: string; aliases: ReadonlyArray<string>; room_name: string | null }>;
  readonly known_scenes: ReadonlyArray<{ scene_id: string; friendly_name: string; scope_version: number }>;
  readonly recent_fresh_state: ReadonlyArray<StateObservation>;
};

// =============================================================================
// Idempotency
// =============================================================================

/**
 * Same request_id with same payload -> reuse result.
 * Same request_id with different payload -> 409 conflict (plan section 8).
 */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

// =============================================================================
// Versioning (plan section 12 release)
// =============================================================================

export const HEARTH_SCHEMA_VERSION = '0.0.1';
export const HEARTH_OPENCLAW_PIN = '2026.9.6';
export const HEARTH_GLINER2_PIN = '2.0.0';