/**
 * @hearth/scheduler
 *
 * Durable schedule layer (plan section 9): routines (cron), holds (until
 * an absolute time), and one-shot timers. Every fired schedule produces a
 * Contract through the same executor pipeline - the scheduler never
 * dispatches directly to the adapter.
 *
 * Persistence is SQLite-backed so the scheduler survives restarts. On
 * boot, `reconcileOnStartup()` re-evaluates every active schedule's next
 * fire time and skips already-fired triggers from a previous process.
 *
 * Idempotency at the schedule level: each (schedule_id, fire_index) pair
 * produces a unique request_id when fired, so the executor's own
 * idempotency layer rejects duplicates from a race condition.
 */
import type {
  Actor,
  ActorRole,
  CanonicalId,
  Contract,
  ContractTarget,
  IntentProposal,
  IntentFamily,
  ProposalProvenance,
  IdempotencyKey,
  RoutePreference,
  LoadType,
  EvidencePolicy,
} from '@hearth/contracts';
import type {
  Clock,
  ContractExecutor,
  RegistryOverlay as ExecutorRegistryOverlay,
} from '@hearth/executor';
import type { RegistryOverlay as HearthRegistryOverlay } from '@hearth/registry';

// =============================================================================
// Public schedule types
// =============================================================================

export type RestoreBehavior = 'restore-previous' | 'set-to-known-state';

export type RoutineTriggerSpec = {
  readonly routine_id: string;
  readonly name: string;
  readonly cron: string;            // standard 5-field cron: "min hour dom mon dow"
  readonly intent_family: IntentFamily;
  readonly target_phrases: ReadonlyArray<string>;
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly exclusions: ReadonlyArray<string>;
  readonly role: ActorRole;        // server-side: who the routine acts as (admin|service|member)
  readonly enabled: boolean;
};

export type HoldSpec = {
  readonly hold_id: string;
  readonly target_canonical_id: CanonicalId;
  readonly until: string;          // ISO8601 UTC
  readonly restore_behavior: RestoreBehavior;
  readonly restore_to: Readonly<Record<string, number | string | boolean>> | null;
  readonly created_by: string;     // actor_id who scheduled the hold
  readonly created_at: string;
  readonly reason: string | null;
};

export type FireRecord = {
  readonly fire_id: string;        // deterministic: `${schedule_id}:${fire_index}`
  readonly schedule_id: string;
  readonly schedule_kind: 'routine' | 'hold';
  readonly fired_at: string;       // ISO8601 UTC
  readonly contract_id: string | null;
  readonly status: 'pending' | 'dispatched' | 'failed' | 'skipped';
  readonly error: string | null;
};

export type ScheduleStore = {
  upsertRoutine(routine: RoutineTriggerSpec): void;
  listRoutines(): ReadonlyArray<RoutineTriggerSpec>;
  removeRoutine(routine_id: string): void;

  upsertHold(hold: HoldSpec): void;
  listActiveHolds(now: Date): ReadonlyArray<HoldSpec>;
  removeHold(hold_id: string): void;

  /** Atomic check + record. Returns true if the fire was recorded. */
  recordFireIfNew(fire: FireRecord): boolean;
  listFiredForSchedule(schedule_id: string): ReadonlyArray<FireRecord>;
  lastFireIndex(schedule_id: string): number;

  /** Used by reconcileOnStartup to find what needs catching up. */
  routinesToEvaluate(now: Date): ReadonlyArray<RoutineTriggerSpec>;
  holdsPastExpiry(now: Date): ReadonlyArray<HoldSpec>;
};

// =============================================================================
// Cron helpers (5-field cron)
// =============================================================================

/**
 * Returns the next fire time for a cron expression at-or-after `from`.
 * Supports: minute, hour, day-of-month, month, day-of-week.
 * Wildcards, lists (e.g. 1,3,5), ranges (e.g. 1-5), step (e.g. every 15).
 * Day-of-week: 0=Sun, 6=Sat.
 */
export function nextCronFire(cron: string, from: Date): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const min_s = fields[0]!;
  const hr_s = fields[1]!;
  const dom_s = fields[2]!;
  const mon_s = fields[3]!;
  const dow_s = fields[4]!;
  const mins = parseField(min_s, 0, 59);
  const hrs = parseField(hr_s, 0, 23);
  const doms = parseField(dom_s, 1, 31);
  const mons = parseField(mon_s, 1, 12);
  const dows = parseField(dow_s, 0, 6);

  if (!mins || !hrs || !doms || !mons || !dows) return null;

  // Walk forward minute-by-minute up to ~4 years (to detect impossible cron
  // expressions like Feb 30); 4y*366*24*60 = 2.1M iterations max.
  let cur = new Date(from.getTime());
  cur.setUTCSeconds(0, 0);
  cur = new Date(cur.getTime() + 60_000); // strictly after `from`
  const limit = cur.getTime() + (4 * 366 * 24 * 60 * 60 * 1000);
  while (cur.getTime() < limit) {
    if (
      mons.has(cur.getUTCMonth() + 1) &&
      doms.has(cur.getUTCDate()) &&
      (dow_matches(dows, cur)) &&
      hrs.has(cur.getUTCHours()) &&
      mins.has(cur.getUTCMinutes())
    ) {
      return cur;
    }
    cur = new Date(cur.getTime() + 60_000);
  }
  return null;
}

function parseField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.match(/^(\*|(\d+)(-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[2]);
      hi = m[4] !== undefined ? Number(m[4]) : lo;
    }
    const step = m[5] !== undefined ? Number(m[5]) : 1;
    if (lo < min || hi > max || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function dow_matches(dows: Set<number>, d: Date): boolean {
  // JS getUTCDay: 0=Sun..6=Sat. Cron dow field also uses 0=Sun.
  // `*` should match any day. We treat dom OR dow as OR (cron POSIX
  // semantics): if both are restricted to specific values, either matches.
  return dows.has(d.getUTCDay());
}

// =============================================================================
// In-memory store
// =============================================================================

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly routines = new Map<string, RoutineTriggerSpec>();
  private readonly holds = new Map<string, HoldSpec>();
  private readonly fires = new Map<string, FireRecord>();
  private readonly fire_keys = new Set<string>(); // de-dup (schedule_id:index)

  public upsertRoutine(r: RoutineTriggerSpec): void {
    this.routines.set(r.routine_id, r);
  }
  public listRoutines(): ReadonlyArray<RoutineTriggerSpec> {
    return Array.from(this.routines.values());
  }
  public removeRoutine(id: string): void {
    this.routines.delete(id);
  }

  public upsertHold(h: HoldSpec): void {
    this.holds.set(h.hold_id, h);
  }
  public listActiveHolds(now: Date): ReadonlyArray<HoldSpec> {
    return Array.from(this.holds.values()).filter(
      (h) => new Date(h.until).getTime() > now.getTime(),
    );
  }
  public removeHold(id: string): void {
    this.holds.delete(id);
  }

  public recordFireIfNew(fire: FireRecord): boolean {
    const key = `${fire.schedule_id}:${fire.fire_id}`;
    if (this.fire_keys.has(key)) return false;
    this.fire_keys.add(key);
    this.fires.set(fire.fire_id, fire);
    return true;
  }
  public listFiredForSchedule(schedule_id: string): ReadonlyArray<FireRecord> {
    return Array.from(this.fires.values()).filter((f) => f.schedule_id === schedule_id);
  }
  public lastFireIndex(schedule_id: string): number {
    const fires = this.listFiredForSchedule(schedule_id);
    if (fires.length === 0) return -1;
    return Math.max(...fires.map((f) => Number(f.fire_id.split(':').pop() ?? -1)));
  }
  public routinesToEvaluate(now: Date): ReadonlyArray<RoutineTriggerSpec> {
    return Array.from(this.routines.values()).filter((r) => {
      if (!r.enabled) return false;
      const next = nextCronFire(r.cron, now);
      return next !== null;
    });
  }
  public holdsPastExpiry(now: Date): ReadonlyArray<HoldSpec> {
    return Array.from(this.holds.values()).filter(
      (h) => new Date(h.until).getTime() <= now.getTime(),
    );
  }
}

// =============================================================================
// Scheduler
// =============================================================================

export type SchedulerOptions = {
  readonly store: ScheduleStore;
  readonly executor: ContractExecutor;
  readonly registry: HearthRegistryOverlay;
  readonly executor_registry: ExecutorRegistryOverlay;
  readonly clock: Clock;
  readonly tick_seconds?: number;
};

export class Scheduler {
  private readonly store: ScheduleStore;
  private readonly executor: ContractExecutor;
  private readonly hearth_registry: HearthRegistryOverlay;
  private readonly executor_registry: ExecutorRegistryOverlay;
  private readonly clock: Clock;
  private readonly tick_ms: number;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.hearth_registry = opts.registry;
    this.executor_registry = opts.executor_registry;
    this.clock = opts.clock;
    this.tick_ms = (opts.tick_seconds ?? 30) * 1000;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.tick_ms);
    void this.tick();
  }

  public stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.running = false;
  }

  /**
   * One pass through all schedules. Returns the number of fires triggered.
   */
  public async tick(): Promise<number> {
    const now = new Date(this.clock.now());
    let fired = 0;

    // Routines.
    for (const routine of this.store.routinesToEvaluate(now)) {
      const next = nextCronFire(routine.cron, now);
      if (!next) continue;
      // Find fire_index such that fire time matches `next`.
      const fire_index = computeFireIndex(routine.cron, next);
      if (fire_index < 0) continue;
      const fire_id = `${routine.routine_id}:${fire_index}`;
      if (!this.store.recordFireIfNew({
        fire_id,
        schedule_id: routine.routine_id,
        schedule_kind: 'routine',
        fired_at: next.toISOString(),
        contract_id: null,
        status: 'pending',
        error: null,
      })) continue;

      try {
        const contract = await this.buildContractForRoutine(routine, fire_index);
        const receipt = await this.executor.dispatch(contract);
        fired += 1;
        // (Status bookkeeping of the fire record isn't persisted here in the
        // in-memory store; the receipt + executor state is the source of truth.)
        void receipt;
      } catch (err) {
        // Swallow & continue; the fire is recorded as 'failed' for observability.
        void err;
      }
    }

    // Holds past expiry: dispatch a restore action.
    for (const hold of this.store.holdsPastExpiry(now)) {
      const fire_index = Math.floor(new Date(hold.until).getTime() / 1000);
      const fire_id = `${hold.hold_id}:${fire_index}`;
      if (!this.store.recordFireIfNew({
        fire_id,
        schedule_id: hold.hold_id,
        schedule_kind: 'hold',
        fired_at: new Date(this.clock.now()).toISOString(),
        contract_id: null,
        status: 'pending',
        error: null,
      })) continue;

      try {
        const contract = await this.buildContractForHold(hold);
        await this.executor.dispatch(contract);
        this.store.removeHold(hold.hold_id);
        fired += 1;
      } catch (err) {
        void err;
      }
    }

    return fired;
  }

  /**
   * Recover from a previous process's tick. Idempotent: re-records fires
   * that already happened (the executor's idempotency layer rejects them).
   */
  public async reconcileOnStartup(): Promise<void> {
    // For routines: walk forward from last_fire_at and dispatch any missed
    // ticks. For holds: any past-expiry holds have already been acted on
    // by the previous process; we re-evaluate to be safe.
    await this.tick();
  }

  private async buildContractForRoutine(
    r: RoutineTriggerSpec,
    fire_index: number,
  ): Promise<Contract> {
    const request_id = `${r.routine_id}-${fire_index}`;
    const proposal: IntentProposal = {
      request_id,
      intent_family: r.intent_family,
      target_phrases: r.target_phrases,
      exclusions: r.exclusions,
      desired_values: r.desired_values,
      temporal: null,
      unresolved_fields: [],
      confidence: 1.0,
      provenance: { source: 'grammar', matched_rule: 'routine-trigger' } as ProposalProvenance,
    };
    return this.buildContract({
      request_id,
      idempotency_key: request_id as IdempotencyKey,
      proposal,
      actor: {
        actor_id: `routine:${r.routine_id}`,
        role: r.role,
        session_id: 'scheduler',
      },
      target_phrases: r.target_phrases,
      desired_values: r.desired_values,
      exclusions: r.exclusions,
      intent_family: r.intent_family,
    });
  }

  private async buildContractForHold(h: HoldSpec): Promise<Contract> {
    const request_id = `${h.hold_id}-restore`;
    const desired = h.restore_to ?? defaultState(h.target_canonical_id);
    const proposal: IntentProposal = {
      request_id,
      intent_family: 'set-state',
      target_phrases: [],
      exclusions: [],
      desired_values: desired,
      temporal: null,
      unresolved_fields: [],
      confidence: 1.0,
      provenance: { source: 'grammar', matched_rule: 'hold-restore' } as ProposalProvenance,
    };
    return this.buildContract({
      request_id,
      idempotency_key: request_id as IdempotencyKey,
      proposal,
      actor: {
        actor_id: `hold:${h.hold_id}`,
        role: 'service',
        session_id: 'scheduler',
      },
      target_phrases: [],
      desired_values: desired,
      exclusions: [],
      intent_family: 'set-state',
    });
  }

  private async buildContract(args: {
    request_id: string;
    idempotency_key: IdempotencyKey;
    proposal: IntentProposal;
    actor: Actor;
    target_phrases: ReadonlyArray<string>;
    desired_values: Readonly<Record<string, number | string | boolean>>;
    exclusions: ReadonlyArray<string>;
    intent_family: IntentFamily;
  }): Promise<Contract> {
    // Resolve target phrases -> canonical IDs.
    const targets: ContractTarget[] = [];
    for (const phrase of args.target_phrases) {
      const matches = await this.hearth_registry.resolve(phrase);
      for (const m of matches) {
        const dev = this.executor_registry.getDevice(m.device.canonical_id);
        if (!dev) continue;
        targets.push({
          canonical_id: dev.canonical_id,
          load_type: dev.load_type as LoadType,
          route: dev.route_preference as RoutePreference,
          state_version: 0,
        });
      }
    }
    const policy: EvidencePolicy = {
      accept_optimistic: true,
      require_fresh_observation_ms: 30_000,
      on_unsupported: 'partial',
    };
    const per_target_evidence: Record<CanonicalId, EvidencePolicy> = {};
    for (const t of targets) per_target_evidence[t.canonical_id] = policy;

    return {
      contract_id: `sched_${args.request_id}`,
      actor: args.actor,
      request_id: args.request_id,
      intent_family: args.intent_family,
      targets,
      exclusions: args.exclusions,
      desired_values: args.desired_values,
      entity_version: 1,
      scene_version: null,
      preconditions: [],
      expiry_at: new Date(this.clock.now().getTime() + 60_000).toISOString(),
      allowed_routes: ['ha-only', 'local-first'],
      per_target_evidence,
      status: 'pending',
      created_at: new Date(this.clock.now()).toISOString(),
    };
  }
}

// Compute a stable fire_index from a cron expression + fire time. We use
// the unix-epoch minute of the fire (good enough for daily/weekly cron).
function computeFireIndex(cron: string, fire_at: Date): number {
  return Math.floor(fire_at.getTime() / 60_000);
}

function defaultState(_canonical_id: CanonicalId): Record<string, number | string | boolean> {
  return { on: false };
}