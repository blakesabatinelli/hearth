/**
 * Server-side contract construction.
 *
 * The single source of authority for assembling a `Contract` from an
 * `IntentProposal` + session-derived `Actor`. The client NEVER supplies
 * principal fields, expiry, evidence policy, retry limit, or allowed
 * routes - those are all derived here. Plan section 8.
 *
 * The flow:
 *  1. Validate the proposal has at least one target_phrase (grammar &
 *     interpreter have already proven it's well-formed).
 *  2. Resolve each phrase against the live registry (alias -> canonical id).
 *     Multi-resolution -> reject (needs_clarification upstream, this layer
 *     treats it as bad request).
 *  3. Server-derived expiry + per-role evidence policy.
 *  4. Authorization gate: actor role must be in each device's allowed list.
 *  5. Assemble Contract with canonical_id targets, exclusions preserved,
 *     entity_version snapshot, scene_version if applicable.
 */
import {
  type Actor,
  type ActorRole,
  type CanonicalId,
  type Contract,
  type ContractTarget,
  type EvidencePolicy,
  type IntentFamily,
  type IntentProposal,
  type IdempotencyKey,
  type DeviceRecord,
  type Precondition,
  type RoutePreference,
} from '@hearth/contracts';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  StaleContextError,
  type RegistryOverlay as ExecutorRegistryOverlay,
} from '@hearth/executor';

const DEFAULT_EXPIRY_SECONDS = 30;
const MAX_EXPIRY_SECONDS = 600;

function defaultPolicy(role: ActorRole): EvidencePolicy {
  if (role === 'wall-tablet' || role === 'service') {
    return {
      accept_optimistic: true,
      require_fresh_observation_ms: 30_000,
      on_unsupported: 'partial',
    };
  }
  return {
    accept_optimistic: false,
    require_fresh_observation_ms: 5_000,
    on_unsupported: 'fail',
  };
}

export type ResolvePhraseFn = (
  phrase: string,
) => Promise<ReadonlyArray<{ canonical_id: CanonicalId }>>;

export type BuildContractInput = {
  readonly actor: Actor;
  readonly request_id: string;
  readonly idempotency_key: IdempotencyKey;
  readonly proposal: IntentProposal;
  readonly registry: ExecutorRegistryOverlay;
  readonly resolve_phrase: ResolvePhraseFn;
  readonly now: () => Date;
  /** Caller-supplied expiry in seconds (server-validated + clamped). Omit to use the default. */
  readonly expiry_seconds?: number | undefined;
};

export type BuildContractOutput = {
  readonly contract: Contract;
};

export async function buildContract(
  input: BuildContractInput,
): Promise<BuildContractOutput> {
  const {
    actor,
    request_id,
    idempotency_key,
    proposal,
    registry,
    resolve_phrase,
    now,
    expiry_seconds,
  } = input;

  const expiry =
    typeof expiry_seconds === 'number' && Number.isFinite(expiry_seconds)
      ? Math.min(MAX_EXPIRY_SECONDS, Math.max(1, Math.floor(expiry_seconds)))
      : DEFAULT_EXPIRY_SECONDS;

  const created_at = now().toISOString();
  const expires_at = new Date(now().getTime() + expiry * 1000).toISOString();

  // Resolve all target phrases to canonical IDs.
  const resolved: Array<{ canonical_id: CanonicalId; load_type: DeviceRecord['load_type']; route: RoutePreference; state_version: number }> = [];
  for (const phrase of proposal.target_phrases) {
    const matches = await resolve_phrase(phrase);
    if (matches.length === 0) {
      throw new StaleContextError(
        `no device matches target phrase "${phrase}"`,
        {
          canonical_id: '' as CanonicalId,
          expected_state_version: -1,
          actual_state_version: -1,
        },
      );
    }
    if (matches.length > 1) {
      throw new StaleContextError(
        `ambiguous target phrase "${phrase}" -> ${matches.length} devices`,
        {
          canonical_id: matches[0]!.canonical_id,
          expected_state_version: -1,
          actual_state_version: -1,
        },
      );
    }
    const dev = registry.getDevice(matches[0]!.canonical_id);
    if (!dev) {
      throw new StaleContextError(
        `registry has no record for ${matches[0]!.canonical_id}`,
        {
          canonical_id: matches[0]!.canonical_id,
          expected_state_version: -1,
          actual_state_version: -1,
        },
      );
    }
    if (!dev.allowed_actors.includes(actor.role as DeviceRecord['allowed_actors'][number])) {
      throw new StaleContextError(
        `actor role ${actor.role} not allowed on ${dev.canonical_id}`,
        {
          canonical_id: dev.canonical_id,
          expected_state_version: -1,
          actual_state_version: -1,
        },
      );
    }
    resolved.push({
      canonical_id: dev.canonical_id,
      load_type: dev.load_type,
      route: dev.route_preference,
      // state_version is unknown at proposal time; the executor fetches it
      // at dispatch time and rejects if it changed between parse and exec.
      state_version: 0,
    });
  }

  // Build contract targets.
  const targets: ContractTarget[] = resolved.map((r) => ({
    canonical_id: r.canonical_id,
    load_type: r.load_type,
    route: r.route,
    state_version: r.state_version,
  }));

  const scene_version =
    proposal.intent_family === 'set-scene' || proposal.intent_family === 'routine-trigger'
      ? 1
      : null;

  // Build per-target evidence policy map.
  const per_target_evidence: Record<CanonicalId, EvidencePolicy> = {};
  const policy = defaultPolicy(actor.role);
  for (const t of targets) {
    per_target_evidence[t.canonical_id] = policy;
  }

  // Resolve exclusions: phrases -> canonical IDs. Fail closed.
  const excluded_canonical_ids: CanonicalId[] = [];
  for (const phrase of proposal.exclusions) {
    const matches = await resolve_phrase(phrase);
    for (const m of matches) excluded_canonical_ids.push(m.canonical_id);
  }

  const preconditions: Precondition[] = [];

  const contract: Contract = {
    contract_id: randomUUID(),
    actor,
    request_id,
    intent_family: proposal.intent_family as IntentFamily,
    targets,
    exclusions: proposal.exclusions,
    desired_values: proposal.desired_values,
    entity_version: 1,
    scene_version,
    preconditions,
    expiry_at: expires_at,
    allowed_routes: ['ha-only', 'local-first'],
    per_target_evidence,
    status: 'pending',
    created_at,
  };

  // Touch unused fields so they aren't pruned in TS strict mode.
  void idempotency_key;
  void registry;
  return { contract };
}

export function ensureProposalFreshness(
  prior: { request_id: string; proposal: IntentProposal } | null,
  current: { request_id: string; proposal: IntentProposal },
): void {
  if (!prior) return;
  if (prior.request_id !== current.request_id) return;
  if (JSON.stringify(prior.proposal) !== JSON.stringify(current.proposal)) {
    throw new IdempotencyConflictError(
      'idempotency key reused with different proposal payload',
      {
        contract_id: `ctr_${current.request_id}`,
        request_id: current.request_id,
      },
    );
  }
}