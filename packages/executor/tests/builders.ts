/**
 * Builders for test fixtures. Centralizes the brand-cast noise so each
 * test focuses on the scenario.
 */

import type {
  Actor,
  CanonicalId,
  Contract,
  ContractTarget,
  EvidencePolicy,
  IntentFamily,
  RoutePreference,
} from '@hearth/contracts';

export function asCanonical(s: string): CanonicalId {
  return s as CanonicalId;
}

export function makeActor(role: Actor['role'] = 'member'): Actor {
  return {
    actor_id: 'actor-1',
    role,
    session_id: 'session-1',
  };
}

export function makeTarget(
  canonical_id: CanonicalId,
  opts: { route?: RoutePreference; state_version?: number } = {},
): ContractTarget {
  return {
    canonical_id,
    load_type: 'light',
    route: opts.route ?? 'ha-only',
    state_version: opts.state_version ?? 1,
  };
}

export function makeContract(overrides: {
  contract_id?: string;
  request_id?: string;
  actor?: Actor;
  intent_family?: IntentFamily;
  targets?: ReadonlyArray<ContractTarget>;
  desired_values?: Readonly<Record<string, number | string | boolean>>;
  entity_version?: number;
  scene_version?: number | null;
  expiry_at?: string;
  allowed_routes?: ReadonlyArray<RoutePreference>;
  per_target_evidence?: Readonly<Record<CanonicalId, EvidencePolicy>>;
  status?: Contract['status'];
  created_at?: string;
}): Contract {
  const contract_id = overrides.contract_id ?? 'contract-1';
  const request_id = overrides.request_id ?? 'request-1';
  const targets = overrides.targets ?? [];
  return {
    contract_id,
    actor: overrides.actor ?? makeActor(),
    request_id,
    intent_family: overrides.intent_family ?? 'set-state',
    targets,
    exclusions: [],
    desired_values: overrides.desired_values ?? {},
    entity_version: overrides.entity_version ?? 1,
    scene_version: overrides.scene_version ?? null,
    preconditions: [],
    expiry_at: overrides.expiry_at ?? '2027-01-01T00:00:00Z',
    allowed_routes: overrides.allowed_routes ?? ['ha-only'],
    per_target_evidence: overrides.per_target_evidence ?? {},
    status: overrides.status ?? 'pending',
    created_at: overrides.created_at ?? '2026-09-24T11:59:00Z',
  };
}

export function evidencePolicy(overrides: Partial<EvidencePolicy> = {}): EvidencePolicy {
  return {
    require_fresh_observation_ms: overrides.require_fresh_observation_ms ?? 0,
    accept_optimistic: overrides.accept_optimistic ?? true,
    on_unsupported: overrides.on_unsupported ?? 'fail',
  };
}