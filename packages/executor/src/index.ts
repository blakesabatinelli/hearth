/**
 * @hearth/executor
 *
 * Contract executor for Hearth (plan section 8). Accepts server-generated
 * Contract objects, dispatches via the injected HomeAssistantAdapter,
 * watches state, builds Receipts with the per-target outcome taxonomy,
 * and supports idempotency, expiry, scene-scope freezing, and restart
 * recovery without blind replay.
 *
 * The HomeAssistantAdapter and registry overlay are interfaces; this
 * package never makes network calls. Tests use in-memory fakes.
 */

import { createHash } from 'node:crypto';
import type {
  Actor,
  CanonicalId,
  Contract,
  ContractStatus,
  ContractTarget,
  DeviceRecord,
  DispatchAck,
  DispatchError,
  EvidencePolicy,
  HomeAssistantAdapter,
  IncidentRecord,
  IntentFamily,
  Receipt,
  Room,
  RoomId,
  StateHandler,
  StateObservation,
  TargetOutcome,
} from '@hearth/contracts';

// =============================================================================
// Errors (exported so API layer can map them to HTTP status codes)
// =============================================================================

/**
 * Same request_id, different payload -> 409 conflict at the API surface.
 */
export class IdempotencyConflictError extends Error {
  public readonly contract_id: string;
  public readonly request_id: string;
  public constructor(message: string, args: { contract_id: string; request_id: string }) {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.contract_id = args.contract_id;
    this.request_id = args.request_id;
  }
}

/**
 * Registry state_version changed between parse and execution. Plan section 8:
 * relative adjustments must be re-evaluated or rejected.
 */
export class StaleContextError extends Error {
  public readonly canonical_id: string;
  public readonly expected_state_version: number;
  public readonly actual_state_version: number;
  public constructor(
    message: string,
    args: { canonical_id: string; expected_state_version: number; actual_state_version: number },
  ) {
    super(message);
    this.name = 'StaleContextError';
    this.canonical_id = args.canonical_id;
    this.expected_state_version = args.expected_state_version;
    this.actual_state_version = args.actual_state_version;
  }
}

/**
 * Imported scene (HA, Hue) without a versioned scope_record or admin
 * attestation. Plan section 8: opaque scenes cannot bypass checks.
 */
export class SceneScopeUncertainError extends Error {
  public readonly scene_id: string;
  public readonly scene_version: number | null;
  public constructor(
    message: string,
    args: { scene_id: string; scene_version: number | null },
  ) {
    super(message);
    this.name = 'SceneScopeUncertainError';
    this.scene_id = args.scene_id;
    this.scene_version = args.scene_version;
  }
}

/**
 * The contract is past expiry_at and cannot be dispatched.
 */
export class ContractExpiredError extends Error {
  public readonly contract_id: string;
  public readonly expiry_at: string;
  public constructor(message: string, args: { contract_id: string; expiry_at: string }) {
    super(message);
    this.name = 'ContractExpiredError';
    this.contract_id = args.contract_id;
    this.expiry_at = args.expiry_at;
  }
}

/**
 * Contract.status forbids dispatch (cancelled / expired / superseded / etc.).
 */
export class ContractStatusError extends Error {
  public readonly contract_id: string;
  public readonly status: string;
  public constructor(message: string, args: { contract_id: string; status: string }) {
    super(message);
    this.name = 'ContractStatusError';
    this.contract_id = args.contract_id;
    this.status = args.status;
  }
}

// =============================================================================
// Clock
// =============================================================================

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
  public nowIso(): string {
    return new Date().toISOString();
  }
}

// =============================================================================
// Registry overlay
// =============================================================================

/**
 * Read-only view over DeviceRecord + Room + scene_version. The executor only
 * reads; overlay edits are a separate package concern.
 *
 * `getSceneScope` returns the frozen scope record for a Hearth-scoped
 * scene. `getSceneAttestation` returns an admin-attested scope for an
 * imported scene. Imported scenes without either fail the executor's
 * scene-scope gate (plan section 8: opaque scripts cannot bypass checks).
 */
export interface RegistryOverlay {
  getDevice(canonical_id: CanonicalId): DeviceRecord | null;
  getRoom(room_id: RoomId): Room | null;
  getSceneScope(scene_id: string):
    | {
        readonly scene_id: string;
        readonly scope_version: number;
        readonly targets: ReadonlyArray<{
          canonical_id: CanonicalId;
          desired_values: Readonly<Record<string, number | string | boolean>>;
        }>;
      }
    | null;
  getSceneAttestation(scene_id: string):
    | { readonly scene_id: string; readonly attested_by: string; readonly attested_at: string }
    | null;
  listDevices(): ReadonlyArray<DeviceRecord>;
}

export type SceneScopeRecord = NonNullable<ReturnType<RegistryOverlay['getSceneScope']>>;
export type SceneAttestationRecord = NonNullable<ReturnType<RegistryOverlay['getSceneAttestation']>>;

export class InMemoryRegistryOverlay implements RegistryOverlay {
  private readonly devices = new Map<CanonicalId, DeviceRecord>();
  private readonly rooms = new Map<RoomId, Room>();
  private readonly scenes = new Map<string, SceneScopeRecord>();
  private readonly attestations = new Map<string, SceneAttestationRecord>();

  public addDevice(device: DeviceRecord): void {
    this.devices.set(device.canonical_id, device);
  }
  public addRoom(room: Room): void {
    this.rooms.set(room.room_id, room);
  }
  public addSceneScope(scene: SceneScopeRecord): void {
    this.scenes.set(scene.scene_id, scene);
  }
  public addSceneAttestation(att: SceneAttestationRecord): void {
    this.attestations.set(att.scene_id, att);
  }

  public getDevice(canonical_id: CanonicalId): DeviceRecord | null {
    return this.devices.get(canonical_id) ?? null;
  }
  public getRoom(room_id: RoomId): Room | null {
    return this.rooms.get(room_id) ?? null;
  }
  public getSceneScope(scene_id: string): SceneScopeRecord | null {
    return this.scenes.get(scene_id) ?? null;
  }
  public getSceneAttestation(scene_id: string): SceneAttestationRecord | null {
    return this.attestations.get(scene_id) ?? null;
  }
  public listDevices(): ReadonlyArray<DeviceRecord> {
    return Array.from(this.devices.values());
  }
}

// =============================================================================
// Execution store (durable)
// =============================================================================

/**
 * Durable persistence for contracts + receipts. The store is authoritative
 * for recovery: on restart the executor loads contracts with status in
 * ('dispatching', 'sent-unconfirmed') and reconciles.
 *
 * Contract payload hash is computed at save time. Idempotency lookups use
 * (request_id, payload_hash). Collision detection uses request_id alone
 * (the API surface maps this to 409).
 */
export interface ExecutionStore {
  saveContract(contract: Contract, payload_hash: string): void;
  findContractByIdempotency(request_id: string, payload_hash: string): Contract | null;
  findContractByRequestId(request_id: string): Contract | null;
  getContract(contract_id: string): Contract | null;
  updateStatus(contract_id: string, status: ContractStatus): void;
  findContractsByStatus(statuses: ReadonlyArray<ContractStatus>): ReadonlyArray<Contract>;
  saveReceipt(receipt: Receipt): void;
  getReceipt(receipt_id: string): Receipt | null;
  getReceiptsForContract(contract_id: string): ReadonlyArray<Receipt>;
  /** v3.0.1: list every receipt (ops introspection + scheduler assertions). */
  allReceipts(): ReadonlyArray<Receipt>;
  /**
   * Drop a contract row. Used on supersede / cancellation cleanup.
   */
  dropIdempotency(contract_id: string): void;
}

// -----------------------------------------------------------------------------
// In-memory store (tests / single-process fixtures)
// -----------------------------------------------------------------------------

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly contracts = new Map<string, Contract>();
  private readonly contractHashes = new Map<string, string>();
  private readonly indexByRequestId = new Map<string, string>();
  private readonly receipts = new Map<string, Receipt>();

  public saveContract(contract: Contract, payload_hash: string): void {
    const existing = this.contracts.get(contract.contract_id);
    if (existing && existing.request_id !== contract.request_id) {
      this.indexByRequestId.delete(existing.request_id);
    }
    this.contracts.set(contract.contract_id, contract);
    this.contractHashes.set(contract.contract_id, payload_hash);
    this.indexByRequestId.set(contract.request_id, contract.contract_id);
  }

  public findContractByIdempotency(request_id: string, payload_hash: string): Contract | null {
    const cid = this.indexByRequestId.get(request_id);
    if (cid === undefined) return null;
    const c = this.contracts.get(cid);
    if (!c) return null;
    return this.contractHashes.get(cid) === payload_hash ? c : null;
  }

  public findContractByRequestId(request_id: string): Contract | null {
    const cid = this.indexByRequestId.get(request_id);
    if (cid === undefined) return null;
    return this.contracts.get(cid) ?? null;
  }

  public getContract(contract_id: string): Contract | null {
    return this.contracts.get(contract_id) ?? null;
  }

  public updateStatus(contract_id: string, status: ContractStatus): void {
    const existing = this.contracts.get(contract_id);
    if (!existing) return;
    this.contracts.set(contract_id, { ...existing, status });
  }

  public findContractsByStatus(statuses: ReadonlyArray<ContractStatus>): ReadonlyArray<Contract> {
    const set = new Set(statuses);
    return Array.from(this.contracts.values()).filter((c) => set.has(c.status));
  }

  public saveReceipt(receipt: Receipt): void {
    this.receipts.set(receipt.receipt_id, receipt);
  }

  public getReceipt(receipt_id: string): Receipt | null {
    return this.receipts.get(receipt_id) ?? null;
  }

  public getReceiptsForContract(contract_id: string): ReadonlyArray<Receipt> {
    return Array.from(this.receipts.values()).filter((r) => r.contract_id === contract_id);
  }

  public allReceipts(): ReadonlyArray<Receipt> {
    return Array.from(this.receipts.values());
  }

  public dropIdempotency(contract_id: string): void {
    const c = this.contracts.get(contract_id);
    if (!c) return;
    this.indexByRequestId.delete(c.request_id);
    this.contracts.delete(contract_id);
    this.contractHashes.delete(contract_id);
  }
}

// -----------------------------------------------------------------------------
// SQLite-backed durable store
// -----------------------------------------------------------------------------

/**
 * Schema notes:
 * - contracts.payload_hash is the canonical hash used for idempotency lookups.
 * - The (request_id, payload_hash) lookup is the primary idempotency path;
 *   findContractByRequestId is the secondary path used for collision
 *   detection (409 mapping). It is implemented by index on request_id.
 * - status is denormalized so recovery queries are cheap.
 */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS contracts (
  contract_id   TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  status        TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_request_id ON contracts(request_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status    ON contracts(status);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id    TEXT PRIMARY KEY,
  contract_id   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_contract_id ON receipts(contract_id);
`;

export interface SqliteExecutionStoreOptions {
  /**
   * Better-sqlite3 Database instance. Caller owns the connection; pass a
   * `:memory:` instance for tests or a file-backed one for production.
   * The caller controls the path; this class does NOT hardcode one.
   */
  db: import('better-sqlite3').Database;
}

export class SqliteExecutionStore implements ExecutionStore {
  private readonly db: import('better-sqlite3').Database;

  public constructor(opts: SqliteExecutionStoreOptions) {
    this.db = opts.db;
    this.db.exec(SQLITE_SCHEMA);
  }

  public saveContract(contract: Contract, payload_hash: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO contracts (contract_id, request_id, payload_hash, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contract_id) DO UPDATE SET
        request_id   = excluded.request_id,
        payload_hash = excluded.payload_hash,
        status       = excluded.status,
        payload_json = excluded.payload_json,
        created_at   = excluded.created_at
    `);
    stmt.run(
      contract.contract_id,
      contract.request_id,
      payload_hash,
      contract.status,
      JSON.stringify(contract),
      contract.created_at,
    );
  }

  public findContractByIdempotency(request_id: string, payload_hash: string): Contract | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM contracts WHERE request_id = ? AND payload_hash = ? LIMIT 1`,
      )
      .get(request_id, payload_hash) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as Contract;
  }

  public findContractByRequestId(request_id: string): Contract | null {
    const row = this.db
      .prepare(`SELECT payload_json FROM contracts WHERE request_id = ? LIMIT 1`)
      .get(request_id) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as Contract;
  }

  public getContract(contract_id: string): Contract | null {
    const row = this.db
      .prepare(`SELECT payload_json FROM contracts WHERE contract_id = ? LIMIT 1`)
      .get(contract_id) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as Contract;
  }

  public updateStatus(contract_id: string, status: ContractStatus): void {
    const existing = this.getContract(contract_id);
    if (!existing) return;
    const updated: Contract = { ...existing, status };
    this.db
      .prepare(`UPDATE contracts SET status = ?, payload_json = ? WHERE contract_id = ?`)
      .run(status, JSON.stringify(updated), contract_id);
  }

  public findContractsByStatus(statuses: ReadonlyArray<ContractStatus>): ReadonlyArray<Contract> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT payload_json FROM contracts WHERE status IN (${placeholders})`)
      .all(...statuses) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as Contract);
  }

  public saveReceipt(receipt: Receipt): void {
    this.db
      .prepare(
        `INSERT INTO receipts (receipt_id, contract_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(receipt_id) DO UPDATE SET
           payload_json = excluded.payload_json`,
      )
      .run(receipt.receipt_id, receipt.contract_id, JSON.stringify(receipt), receipt.created_at);
  }

  public getReceipt(receipt_id: string): Receipt | null {
    const row = this.db
      .prepare(`SELECT payload_json FROM receipts WHERE receipt_id = ? LIMIT 1`)
      .get(receipt_id) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json) as Receipt;
  }

  public getReceiptsForContract(contract_id: string): ReadonlyArray<Receipt> {
    const rows = this.db
      .prepare(`SELECT payload_json FROM receipts WHERE contract_id = ?`)
      .all(contract_id) as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as Receipt);
  }

  public allReceipts(): ReadonlyArray<Receipt> {
    const rows = this.db
      .prepare(`SELECT payload_json FROM receipts`)
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => JSON.parse(r.payload_json) as Receipt);
  }

  public dropIdempotency(contract_id: string): void {
    this.db.prepare(`DELETE FROM contracts WHERE contract_id = ?`).run(contract_id);
  }
}

// =============================================================================
// Payload hashing (idempotency)
// =============================================================================

/**
 * Canonical hash of a contract's dispatch-relevant fields. Stable across
 * processes: keys are sorted before hashing so JSON key order does not
 * cause spurious collisions.
 *
 * The hash deliberately excludes `status` (mutable lifecycle field) and
 * `created_at` (clock noise). Idempotency is about payload equality, not
 * metadata drift.
 */
export function contractPayloadHash(contract: Contract): string {
  const canonical = {
    actor: contract.actor,
    intent_family: contract.intent_family,
    // v3.0.1: hash only the canonical_ids and load_types/route; state_version
    // is an observation detail that changes between builds and is not part
    // of the dispatch intent. Re-running the same proposal twice produces
    // the same hash even if the observed state_version advanced.
    targets: contract.targets.map((t) => ({
      canonical_id: t.canonical_id,
      load_type: t.load_type,
      route: t.route,
    })),
    exclusions: contract.exclusions,
    desired_values: contract.desired_values,
    entity_version: contract.entity_version,
    scene_version: contract.scene_version,
    preconditions: contract.preconditions,
    allowed_routes: contract.allowed_routes,
    per_target_evidence: contract.per_target_evidence,
  };
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}

// =============================================================================
// Outcome aggregation
// =============================================================================

const EVIDENCE_DEFAULT: EvidencePolicy = {
  require_fresh_observation_ms: 0,
  accept_optimistic: true,
  on_unsupported: 'fail',
};

/**
 * Aggregate per-target outcomes into a single ContractStatus. Plan section 8
 * calls for explicit, no-shapes detection: this table is the visible rule.
 */
function aggregate(per_target: Readonly<Record<CanonicalId, TargetOutcome>>): ContractStatus {
  const kinds: TargetOutcome['kind'][] = Object.values(per_target).map((t) => t.kind);
  if (kinds.length === 0) return 'failed';
  const has = (k: TargetOutcome['kind']): boolean => kinds.includes(k);

  if (kinds.every((k) => k === 'already-satisfied')) return 'no-op';
  if (kinds.every((k) => k === 'observed-after-command' || k === 'already-satisfied')) {
    return 'confirmed';
  }
  if (has('failed')) {
    return has('observed-after-command') || has('already-satisfied') ? 'partial' : 'failed';
  }
  if (has('observed-after-command') || has('already-satisfied')) return 'partial';
  if (has('optimistic-only') || has('unknown-after-failure')) return 'sent-unconfirmed';
  return 'failed';
}

function alreadySatisfied(
  obs: StateObservation,
  desired: Readonly<Record<string, number | string | boolean>>,
): boolean {
  for (const [k, v] of Object.entries(desired)) {
    const actual = obs.values[k];
    if (actual === undefined) return false;
    if (typeof v === 'number' && typeof actual === 'number') {
      if (Math.abs(actual - v) > 2) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

function freshEnough(obs: StateObservation, ms: number, now: Date): boolean {
  if (ms <= 0) return true;
  const t = Date.parse(obs.observed_at);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= ms;
}

function canDispatch(status: ContractStatus): boolean {
  return status === 'pending' || status === 'dispatching' || status === 'sent-unconfirmed';
}

function asProviderError(err: unknown): DispatchError {
  if (err instanceof Error) {
    return { code: 'provider-error', provider: 'ha', message: err.message };
  }
  return { code: 'provider-error', provider: 'ha', message: String(err) };
}

// =============================================================================
// Contract executor
// =============================================================================

export interface ContractExecutorDeps {
  adapter: HomeAssistantAdapter;
  registry: RegistryOverlay;
  store: ExecutionStore;
  clock: Clock;
}

export interface DispatchOptions {
  /**
   * Optional override of the payload hash (used for idempotency). When
   * omitted, the executor computes one from the contract.
   */
  payload_hash?: string;
}

export class ContractExecutor {
  private readonly adapter: HomeAssistantAdapter;
  private readonly registry: RegistryOverlay;
  private readonly store: ExecutionStore;
  private readonly clock: Clock;

  public constructor(deps: ContractExecutorDeps) {
    this.adapter = deps.adapter;
    this.registry = deps.registry;
    this.store = deps.store;
    this.clock = deps.clock;
  }

  /**
   * Dispatch a contract. Idempotency, expiry, status, evidence, scene-scope,
   * and stale-context rules all live here.
   *
   * Order of checks (each can throw or short-circuit):
   *  1. (idempotency) same (request_id, payload_hash) -> return existing receipt
   *  2. (idempotency) same request_id, different payload -> throw IdempotencyConflictError
   *  3. status check; terminal statuses short-circuit with a typed receipt
   *  4. expiry_at <= now -> mark expired, no provider call
   *  5. set-scene: validate scene scope (scope_record OR admin attestation)
   *  6. for each target: stale-context check (state_version match)
   *  7. register watchers BEFORE dispatch; fresh observation matching desired -> already-satisfied
   *  8. dispatch remaining targets; collect per-target outcomes; honour EvidencePolicy
   *  9. write receipt; update contract status
   */
  public async dispatch(contract: Contract, opts: DispatchOptions = {}): Promise<Receipt> {
    const payload_hash = opts.payload_hash ?? contractPayloadHash(contract);

    // (1) idempotency hit: same (request_id, payload_hash) AND a prior
    // receipt exists -> reuse. If only the contract row exists (interrupted
    // dispatch, no receipt), proceed as a fresh dispatch: recovery depends
    // on this branch.
    const sameHash = this.store.findContractByIdempotency(contract.request_id, payload_hash);
    if (sameHash) {
      const prior = this.store.getReceiptsForContract(sameHash.contract_id)[0];
      if (prior) return prior;
    }

    // (2) idempotency conflict: same request_id with a DIFFERENT payload.
    // Same-hash case already handled in branch (1).
    const byReq = this.store.findContractByRequestId(contract.request_id);
    if (byReq && byReq.contract_id !== contract.contract_id) {
      throw new IdempotencyConflictError(
        `request_id ${contract.request_id} already used with a different payload`,
        { contract_id: byReq.contract_id, request_id: contract.request_id },
      );
    }

    // (3) terminal status check
    if (!canDispatch(contract.status)) {
      this.persistAndStatus(contract, payload_hash, contract.status);
      return buildReceipt({
        contract_id: contract.contract_id,
        actor: contract.actor,
        per_target: {},
        created_at: this.clock.nowIso(),
        aggregate: contract.status,
      });
    }

    // (4) expiry
    if (Date.parse(contract.expiry_at) <= this.clock.now().getTime()) {
      this.persistAndStatus(contract, payload_hash, 'expired');
      return buildReceipt({
        contract_id: contract.contract_id,
        actor: contract.actor,
        per_target: {},
        created_at: this.clock.nowIso(),
        aggregate: 'expired',
      });
    }

    // (5) scene scope
    if (contract.intent_family === 'set-scene') {
      this.validateSceneScope(contract);
    }

    // (6) stale-context check
    for (const target of contract.targets) {
      const obs = await this.adapter.getState(target.canonical_id);
      if (obs.state_version !== target.state_version) {
        throw new StaleContextError(
          `state_version changed for ${target.canonical_id}: expected ${target.state_version}, got ${obs.state_version}`,
          {
            canonical_id: target.canonical_id,
            expected_state_version: target.state_version,
            actual_state_version: obs.state_version,
          },
        );
      }
    }

    // Persist as dispatching so a crash mid-flight can be recovered.
    this.persistAndStatus(contract, payload_hash, 'dispatching');

    // (7 + 8) per-target: register watcher, check already-satisfied, dispatch.
    const per_target: Record<string, TargetOutcome> = {};
    const subs: Array<{ unsubscribe(): void }> = [];

    try {
      for (const target of contract.targets) {
        const policy = contract.per_target_evidence[target.canonical_id] ?? EVIDENCE_DEFAULT;
        const desired = contract.desired_values;

        // Watcher resolves with a fresh observation that matches the goal.
        // Stays open across dispatch so a fast state event is not missed.
        const observed = new Promise<StateObservation | null>((resolve) => {
          let settled = false;
          const handler: StateHandler = (obs: StateObservation) => {
            if (settled) return;
            if (!freshEnough(obs, policy.require_fresh_observation_ms, this.clock.now())) return;
            settled = true;
            resolve(obs);
          };
          const sub = this.adapter.subscribe([target.canonical_id], handler);
          subs.push(sub);
          // Initial getState doubles as the already-satisfied fast path.
          this.adapter
            .getState(target.canonical_id)
            .then((obs: StateObservation) => {
              if (settled) return;
              if (!freshEnough(obs, policy.require_fresh_observation_ms, this.clock.now())) return;
              if (alreadySatisfied(obs, desired)) {
                settled = true;
                resolve(obs);
              }
            })
            .catch(() => {
              /* swallowed; recovery handles it */
            });
        });

        // Already-satisfied fast path: check if the initial getState
        // settled the promise (non-blocking).
        const early = await Promise.race([
          observed,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
        ]);
        if (early && alreadySatisfied(early, desired)) {
          per_target[target.canonical_id] = {
            kind: 'already-satisfied',
            observed_at: early.observed_at,
          };
          continue;
        }

        // Dispatch.
        let ack: DispatchAck;
        try {
          ack = await this.adapter.dispatch(target, desired);
        } catch (err) {
          per_target[target.canonical_id] = {
            kind: 'failed',
            error: asProviderError(err),
          };
          continue;
        }

        if (ack.kind === 'rejected') {
          per_target[target.canonical_id] = {
            kind: 'failed',
            error: { code: 'route-unavailable', route: target.route, message: ack.reason },
          };
          continue;
        }

        if (ack.kind === 'no-op') {
          // Adapter explicitly told us state already matched; treat as
          // already-satisfied (a fresh observation from the adapter's POV).
          per_target[target.canonical_id] = {
            kind: 'already-satisfied',
            observed_at: ack.observed_at,
          };
          continue;
        }

        // Wait for a fresh observation up to a short bounded window. The
        // adapter controls real timing; we give the watcher a chance to
        // deliver before falling back.
        const observedAfter = await Promise.race([
          observed,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);

        if (
          observedAfter &&
          freshEnough(observedAfter, policy.require_fresh_observation_ms, this.clock.now())
        ) {
          if (alreadySatisfied(observedAfter, desired)) {
            per_target[target.canonical_id] = {
              kind: 'observed-after-command',
              observed_at: observedAfter.observed_at,
              state_version: observedAfter.state_version,
            };
            continue;
          }
        }

        // No fresh observation: classify by policy.
        if (policy.accept_optimistic) {
          per_target[target.canonical_id] = {
            kind: 'optimistic-only',
            echoed_at: ack.echoed_at,
          };
        } else {
          per_target[target.canonical_id] = {
            kind: 'failed',
            error: {
              code: 'provider-error',
              provider: 'ha',
              message: 'sent-unconfirmed and accept_optimistic=false',
            },
          };
        }
      }
    } finally {
      for (const sub of subs) {
        try {
          sub.unsubscribe();
        } catch {
          /* ignore */
        }
      }
    }

    const aggregateStatus = aggregate(per_target);
    this.persistAndStatus(contract, payload_hash, aggregateStatus);

    const receipt = buildReceipt({
      contract_id: contract.contract_id,
      actor: contract.actor,
      per_target,
      created_at: this.clock.nowIso(),
      aggregate: aggregateStatus,
    });
    this.store.saveReceipt(receipt);
    return receipt;
  }

  /**
   * Cancel a contract. Persists the cancellation. Does not interrupt an
   * in-flight dispatch (single-process by design; recovery covers crashes).
   */
  public cancel(contract_id: string, _reason: string): void {
    const existing = this.store.getContract(contract_id);
    if (!existing) return;
    if (existing.status === 'dispatching' || existing.status === 'pending') {
      this.store.updateStatus(contract_id, 'cancelled');
    }
  }

  /**
   * v3.0.1: read all receipts for a given contract_id. The store is
   * private; this is the typed accessor used by tests, scheduler
   * integration, and ops tooling.
   */
  public getReceiptsForContract(contract_id: string): ReadonlyArray<Receipt> {
    return this.store.getReceiptsForContract(contract_id);
  }

  /**
   * v3.0.1: return every receipt in the store, in dispatch order.
   */
  public listReceipts(): ReadonlyArray<Receipt> {
    return this.store.allReceipts();
  }

  /**
   * Restart recovery. Loads all contracts with status in
   * ('dispatching', 'sent-unconfirmed'). For each:
   *   - past expiry_at -> mark expired (no provider call)
   *   - superseded -> leave alone; supersede happens elsewhere
   *   - a fresh trustworthy observation that matches the goal -> mark no-op
   *   - otherwise retry once under bounded policy via dispatch()
   */
  public async reconcileOnStartup(): Promise<ReadonlyArray<Receipt>> {
    const interrupted = this.store.findContractsByStatus(['dispatching', 'sent-unconfirmed']);
    const out: Receipt[] = [];
    for (const contract of interrupted) {
      if (Date.parse(contract.expiry_at) <= this.clock.now().getTime()) {
        this.store.updateStatus(contract.contract_id, 'expired');
        out.push(
          buildReceipt({
            contract_id: contract.contract_id,
            actor: contract.actor,
            per_target: {},
            created_at: this.clock.nowIso(),
            aggregate: 'expired',
          }),
        );
        continue;
      }

      let anyNeededDispatch = false;
      const per_target: Record<string, TargetOutcome> = {};
      for (const target of contract.targets) {
        try {
          const obs = await this.adapter.getState(target.canonical_id);
          const policy = contract.per_target_evidence[target.canonical_id] ?? EVIDENCE_DEFAULT;
          if (freshEnough(obs, policy.require_fresh_observation_ms, this.clock.now())) {
            if (alreadySatisfied(obs, contract.desired_values)) {
              per_target[target.canonical_id] = {
                kind: 'observed-after-command',
                observed_at: obs.observed_at,
                state_version: obs.state_version,
              };
              continue;
            }
          }
          anyNeededDispatch = true;
          per_target[target.canonical_id] = {
            kind: 'unknown-after-failure',
            last_known_state: obs.values,
          };
        } catch {
          anyNeededDispatch = true;
        }
      }

      if (!anyNeededDispatch) {
        this.store.updateStatus(contract.contract_id, 'no-op');
        const r = buildReceipt({
          contract_id: contract.contract_id,
          actor: contract.actor,
          per_target,
          created_at: this.clock.nowIso(),
          aggregate: 'no-op',
        });
        this.store.saveReceipt(r);
        out.push(r);
        continue;
      }

      // Retry once: re-dispatch; idempotency + status checks run again.
      try {
        const fresh = await this.dispatch(contract);
        out.push(fresh);
      } catch (err) {
        const r = buildReceipt({
          contract_id: contract.contract_id,
          actor: contract.actor,
          per_target: {},
          created_at: this.clock.nowIso(),
          aggregate: 'failed',
          incident: incidentFromError(err, contract.intent_family),
        });
        this.store.saveReceipt(r);
        this.store.updateStatus(contract.contract_id, 'failed');
        out.push(r);
      }
    }
    return out;
  }

  private persistAndStatus(contract: Contract, payload_hash: string, status: ContractStatus): void {
    this.store.saveContract({ ...contract, status }, payload_hash);
  }

  private validateSceneScope(contract: Contract): void {
    const scene_id = String(contract.desired_values['scene_id'] ?? '');
    if (!scene_id) {
      throw new SceneScopeUncertainError('set-scene contract has no scene_id', {
        scene_id: '',
        scene_version: contract.scene_version,
      });
    }
    const scope = this.registry.getSceneScope(scene_id);
    if (scope) return;
    const att = this.registry.getSceneAttestation(scene_id);
    if (att) return;
    throw new SceneScopeUncertainError(
      `scene ${scene_id} has no versioned scope_record or admin attestation`,
      { scene_id, scene_version: contract.scene_version },
    );
  }
}

function incidentFromError(err: unknown, _intent: IntentFamily): IncidentRecord {
  if (err instanceof StaleContextError) {
    return {
      kind: 'invariant-violation',
      detail: `stale context at recovery: ${err.message}`,
      paused_categories: [],
    };
  }
  return {
    kind: 'invariant-violation',
    detail: err instanceof Error ? err.message : String(err),
    paused_categories: [],
  };
}

// =============================================================================
// Receipt builder (private)
// =============================================================================

interface BuildReceiptArgs {
  contract_id: string;
  actor: Actor;
  per_target: Record<string, TargetOutcome>;
  created_at: string;
  aggregate: ContractStatus;
  incident?: IncidentRecord;
}

function buildReceipt(args: BuildReceiptArgs): Receipt {
  const per: Record<CanonicalId, TargetOutcome> = {};
  for (const [k, v] of Object.entries(args.per_target)) {
    per[k as CanonicalId] = v;
  }
  return {
    receipt_id: `${args.contract_id}:${args.created_at}`,
    contract_id: args.contract_id,
    actor: args.actor,
    per_target: per,
    aggregate: args.aggregate,
    created_at: args.created_at,
    incident: args.incident ?? null,
  };
}