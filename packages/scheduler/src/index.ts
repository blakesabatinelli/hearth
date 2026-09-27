/**
 * @hearth/scheduler
 *
 * Durable schedule layer (plan section 9): routines (cron), holds (until
 * an absolute time), and one-shot timers. Every fired schedule produces a
 * Contract through the same executor pipeline - the scheduler never
 * dispatches directly to the adapter.
 *
 * Persistence is SQLite-backed so the scheduler survives restarts. Cron
 * fields use UTC. Only the current due minute is eligible, so missed
 * occurrences are not caught up after a restart. A pending fire from a prior
 * process is marked skipped because its outcome is uncertain and must not be
 * replayed.
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
import { cronMatchesAtMinuteInTimeZone, wallClockMinuteIdentity } from './cron.js';
export { cronMatchesAtMinute, cronMatchesAtMinuteInTimeZone, isValidTimeZone, nextCronFire, wallClockMinuteIdentity } from './cron.js';

// =============================================================================
// Public schedule types
// =============================================================================

export type RestoreBehavior = 'restore-previous' | 'set-to-known-state';

export type RoutineTriggerSpec = {
  readonly routine_id: string;
  readonly name: string;
  readonly cron: string;            // 5-field UTC cron: "min hour dom mon dow"
  readonly intent_family: IntentFamily;
  readonly target_phrases: ReadonlyArray<string>;
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly exclusions: ReadonlyArray<string>;
  /** IANA local time zone. Older stored routines without it use UTC. */
  readonly time_zone?: string;
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
  /** Update the outcome of a previously reserved fire. */
  updateFire(fire: FireRecord): boolean;
  listFiredForSchedule(schedule_id: string): ReadonlyArray<FireRecord>;
  lastFireIndex(schedule_id: string): number;

  /** Return enabled routines whose cron matches the current minute. */
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
    const key = `${fire.schedule_id}\u0000${fire.fire_id}`;
    if (this.fire_keys.has(key)) return false;
    this.fire_keys.add(key);
    this.fires.set(key, fire);
    return true;
  }
  public updateFire(fire: FireRecord): boolean {
    const key = `${fire.schedule_id}\u0000${fire.fire_id}`;
    if (!this.fires.has(key)) return false;
    this.fires.set(key, fire);
    return true;
  }
  public listFiredForSchedule(schedule_id: string): ReadonlyArray<FireRecord> {
    return Array.from(this.fires.values())
      .filter((f) => f.schedule_id === schedule_id)
      .sort((a, b) => a.fired_at.localeCompare(b.fired_at));
  }
  public lastFireIndex(schedule_id: string): number {
    const fires = this.listFiredForSchedule(schedule_id);
    if (fires.length === 0) return -1;
    return Math.max(...fires.map((f) => Number(f.fire_id.split(':').pop() ?? -1)));
  }
  public routinesToEvaluate(now: Date): ReadonlyArray<RoutineTriggerSpec> {
    const current_minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return Array.from(this.routines.values()).filter((r) => {
      return r.enabled && cronMatchesAtMinuteInTimeZone(r.cron, current_minute, r.time_zone ?? 'UTC');
    });
  }
  public holdsPastExpiry(now: Date): ReadonlyArray<HoldSpec> {
    return Array.from(this.holds.values()).filter(
      (h) => new Date(h.until).getTime() <= now.getTime(),
    );
  }
}

export { SqliteScheduleStore } from './sqlite-store.js';

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
  /**
   * v3.0.1: optional state-version lookup. When provided the scheduler
   * records the live observed state_version on each contract target so the
   * executor's stale-context check at dispatch time has a real comparison.
   * When absent the scheduler falls back to 1 (the executor still re-checks).
   */
  readonly state_lookup?: (canonical_id: string) => Promise<number>;
};

export class Scheduler {
  private readonly store: ScheduleStore;
  private readonly executor: ContractExecutor;
  private readonly hearth_registry: HearthRegistryOverlay;
  private readonly executor_registry: ExecutorRegistryOverlay;
  private readonly clock: Clock;
  private readonly tick_ms: number;
  private state_lookup: ((canonical_id: string) => Promise<number>) | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  public constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.hearth_registry = opts.registry;
    this.executor_registry = opts.executor_registry;
    this.clock = opts.clock;
    this.tick_ms = (opts.tick_seconds ?? 30) * 1000;
    this.state_lookup = opts.state_lookup ?? null;
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
      const due = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
      const fire_index = computeFireIndex(routine.cron, due, routine.time_zone ?? 'UTC');
      if (fire_index < 0) continue;
      const fire_id = `${routine.routine_id}:${fire_index}`;
      if (!this.store.recordFireIfNew({
        fire_id,
        schedule_id: routine.routine_id,
        schedule_kind: 'routine',
        fired_at: due.toISOString(),
        contract_id: null,
        status: 'pending',
        error: null,
      })) continue;

      try {
        const contract = await this.buildContractForRoutine(routine, fire_index);
        const receipt = await this.executor.dispatch(contract);
        fired += 1;
        this.store.updateFire({
          fire_id,
          schedule_id: routine.routine_id,
          schedule_kind: 'routine',
          fired_at: due.toISOString(),
          contract_id: receipt.contract_id,
          status: 'dispatched',
          error: null,
        });
      } catch (err) {
        this.store.updateFire({
          fire_id,
          schedule_id: routine.routine_id,
          schedule_kind: 'routine',
          fired_at: due.toISOString(),
          contract_id: `sched_${routine.routine_id}-${fire_index}`,
          status: 'failed',
          error: (err as Error).message,
        });
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
        const receipt = await this.executor.dispatch(contract);
        this.store.removeHold(hold.hold_id);
        fired += 1;
        this.store.updateFire({
          fire_id,
          schedule_id: hold.hold_id,
          schedule_kind: 'hold',
          fired_at: new Date(this.clock.now()).toISOString(),
          contract_id: receipt.contract_id,
          status: 'dispatched',
          error: null,
        });
      } catch (err) {
        this.store.updateFire({
          fire_id,
          schedule_id: hold.hold_id,
          schedule_kind: 'hold',
          fired_at: new Date(this.clock.now()).toISOString(),
          contract_id: `sched_${hold.hold_id}-restore`,
          status: 'failed',
          error: (err as Error).message,
        });
      }
    }

    return fired;
  }

  /**
   * Recover from a previous process's tick without replaying uncertain work.
   */
  public async reconcileOnStartup(): Promise<void> {
    // A pending record means a prior process reserved the occurrence but did
    // not persist its final outcome. The executor may have sent it, so never
    // replay it blindly. Mark it uncertain and allow later cron occurrences.
    for (const routine of this.store.listRoutines()) {
      for (const fire of this.store.listFiredForSchedule(routine.routine_id)) {
        if (fire.status === 'pending') {
          this.store.updateFire({
            ...fire,
            status: 'skipped',
            error: 'prior dispatch outcome unknown; recovery suppressed replay',
          });
        }
      }
    }
    for (const hold of this.store.holdsPastExpiry(new Date(this.clock.now()))) {
      for (const fire of this.store.listFiredForSchedule(hold.hold_id)) {
        if (fire.status === 'pending') {
          this.store.updateFire({
            ...fire,
            status: 'skipped',
            error: 'prior restore outcome unknown; recovery suppressed replay',
          });
        }
      }
    }
    // Process only an occurrence due in this UTC minute; offline occurrences
    // are intentionally not replayed after restart.
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
      // v3.0.1: hold's held canonical_id flows into target_phrases here so
      // the scheduler's own buildContract() resolves it back to a real
      // target. This produces a non-empty Contract whose actor is the
      // hold's creator and whose desired_values are the restore-to set.
      target_phrases: [h.target_canonical_id as string],
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
      target_phrases: [h.target_canonical_id as string],
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
        // v3.0.1: capture the device's state_version at dispatch-build time
        // rather than the v3.0 placeholder of 0. When an adapter handle is
        // available, query it; otherwise fall back to 1 so the value
        // distinguishes "captured" from "zero-silenced", and rely on the
        // executor's stale-context re-check at execute time.
        let state_version = 1;
        const lookup = this.state_lookup;
        if (lookup) {
          try {
            const observed = await lookup(dev.canonical_id);
            if (typeof observed === 'number') state_version = observed;
          } catch {
            // leave at 1
          }
        }
        targets.push({
          canonical_id: dev.canonical_id,
          load_type: dev.load_type as LoadType,
          route: dev.route_preference as RoutePreference,
          state_version,
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
function computeFireIndex(cron: string, fire_at: Date, time_zone = 'UTC'): number {
  if (!cronMatchesAtMinuteInTimeZone(cron, fire_at, time_zone)) return -1;
  return wallClockMinuteIdentity(fire_at, time_zone) ?? -1;
}

function defaultState(_canonical_id: CanonicalId): Record<string, number | string | boolean> {
  return { on: false };
}
