import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  nextCronFire,
  cronMatchesAtMinuteInTimeZone,
  wallClockMinuteIdentity,
  isValidTimeZone,
  InMemoryScheduleStore,
  SqliteScheduleStore,
  Scheduler,
  type RoutineTriggerSpec,
} from '../src/index.js';
import { ContractExecutor, InMemoryExecutionStore, SystemClock, InMemoryRegistryOverlay, type Clock } from '@hearth/executor';
import { FakeHAAdapter, loadDefaultFixture } from '@hearth/ha-adapter';
import { RegistryOverlay } from '@hearth/registry';
import Database from 'better-sqlite3';

describe('nextCronFire', () => {
  it('returns null for invalid cron', () => {
    expect(nextCronFire('not-a-cron', new Date())).toBeNull();
  });

  it('finds the next minute when min is a specific value', () => {
    // "30 * * * *" = every hour at minute 30
    const from = new Date('2026-09-24T10:00:00Z');
    const next = nextCronFire('30 * * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(30);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    // Should be exactly at 10:30 (30 min after from)
    expect(next!.getUTCHours()).toBe(10);
  });

  it('handles wildcard + step (*/15 minutes)', () => {
    const from = new Date('2026-09-24T10:07:00Z');
    const next = nextCronFire('*/15 * * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(15);
  });

  it('handles comma lists (1,3,5 hours)', () => {
    const from = new Date('2026-09-24T00:00:00Z');
    const next = nextCronFire('0 1,3,5 * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(1);
  });

  it('handles ranges (1-5 minutes)', () => {
    const from = new Date('2026-09-24T10:00:00Z');
    const next = nextCronFire('1-5 * * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(1);
  });

  it('returns null for impossible cron (Feb 30)', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextCronFire('0 0 30 2 *', from)).toBeNull();
  });

  it('uses POSIX OR semantics when both day-of-month and day-of-week are restricted', () => {
    const from = new Date('2026-09-02T00:00:00Z');
    expect(nextCronFire('0 9 1 * 2', from)?.toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });
});

describe('time-zone aware cron matching', () => {
  it('validates time zones and skips local times removed by spring-forward', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(cronMatchesAtMinuteInTimeZone('30 2 * * *', new Date('2026-03-08T08:30:00.000Z'), 'America/Chicago')).toBe(false);
  });

  it('matches both fall-back instants but gives them one local fire identity', () => {
    const first = new Date('2026-11-01T06:30:00.000Z');
    const repeated = new Date('2026-11-01T07:30:00.000Z');
    expect(cronMatchesAtMinuteInTimeZone('30 1 * * *', first, 'America/Chicago')).toBe(true);
    expect(cronMatchesAtMinuteInTimeZone('30 1 * * *', repeated, 'America/Chicago')).toBe(true);
    expect(wallClockMinuteIdentity(first, 'America/Chicago')).toBe(wallClockMinuteIdentity(repeated, 'America/Chicago'));
  });
});

describe('InMemoryScheduleStore', () => {
  it('records a fire once and rejects duplicates', () => {
    const store = new InMemoryScheduleStore();
    expect(store.recordFireIfNew({
      fire_id: 'r1:0',
      schedule_id: 'r1',
      schedule_kind: 'routine',
      fired_at: '2026-09-24T10:00:00Z',
      contract_id: null,
      status: 'pending',
      error: null,
    })).toBe(true);
    expect(store.recordFireIfNew({
      fire_id: 'r1:0',
      schedule_id: 'r1',
      schedule_kind: 'routine',
      fired_at: '2026-09-24T10:00:00Z',
      contract_id: null,
      status: 'pending',
      error: null,
    })).toBe(false);
    expect(store.lastFireIndex('r1')).toBe(0);
  });
});

describe('SqliteScheduleStore', () => {
  it('persists routines, holds, and fire status across database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hearth-schedule-'));
    const database_path = join(directory, 'schedules.sqlite');
    let db = new Database(database_path);
    let store = new SqliteScheduleStore({ db });
    const routine: RoutineTriggerSpec = {
      routine_id: 'morning',
      name: 'Morning lights',
      cron: '0 7 * * *',
      intent_family: 'set-state',
      target_phrases: ['lamp'],
      desired_values: { on: true },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    const hold = {
      hold_id: 'quiet-hours',
      target_canonical_id: 'ha:light.lamp' as never,
      until: '2026-09-25T08:00:00.000Z',
      restore_behavior: 'set-to-known-state' as const,
      restore_to: { on: false },
      created_by: 'admin-test',
      created_at: '2026-09-24T20:00:00.000Z',
      reason: 'test',
    };
    const fire = {
      fire_id: 'morning:29887980',
      schedule_id: 'morning',
      schedule_kind: 'routine' as const,
      fired_at: '2026-09-25T07:00:00.000Z',
      contract_id: null,
      status: 'pending' as const,
      error: null,
    };

    try {
      store.upsertRoutine(routine);
      store.upsertHold(hold);
      expect(store.recordFireIfNew(fire)).toBe(true);
      expect(store.updateFire({ ...fire, status: 'dispatched', contract_id: 'contract-morning' })).toBe(true);
      db.close();

      db = new Database(database_path);
      store = new SqliteScheduleStore({ db });
      expect(store.listRoutines()).toEqual([routine]);
      expect(store.listActiveHolds(new Date('2026-09-24T21:00:00.000Z'))).toEqual([hold]);
      expect(store.listFiredForSchedule('morning')).toEqual([
        { ...fire, status: 'dispatched', contract_id: 'contract-morning' },
      ]);
      expect(store.lastFireIndex('morning')).toBe(29887980);
      expect(store.recordFireIfNew(fire)).toBe(false);
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Scheduler.tick()', () => {
  function buildEnv() {
    const fixture = loadDefaultFixture();
    const hearth_registry = new RegistryOverlay({
      devices: fixture.devices,
      rooms: fixture.rooms,
      entity_version: 1,
      scene_versions: {},
    });
    const executor_registry = new InMemoryRegistryOverlay();
    for (const d of fixture.devices) executor_registry.addDevice(d);
    for (const r of fixture.rooms) executor_registry.addRoom(r);
    const adapter = new FakeHAAdapter(fixture);
    const store = new InMemoryExecutionStore();
    let current = new Date();
    const clock: Clock & { setTo: (value: string) => void } = {
      now: () => new Date(current),
      nowIso: () => current.toISOString(),
      setTo: (value: string) => { current = new Date(value); },
    };
    const executor = new ContractExecutor({
      adapter,
      registry: executor_registry,
      store,
      clock,
    });
    const schedule_store = new InMemoryScheduleStore();
    return {
      fixture, hearth_registry, executor_registry, adapter, store, clock,
      executor, schedule_store,
    };
  }

  it('does not fire a routine before its due minute, then fires it once when due', async () => {
    const env = buildEnv();
    env.clock.setTo('2026-09-24T10:29:30.000Z');
    const routine: RoutineTriggerSpec = {
      routine_id: 'r-due',
      name: 'fires-at-1030',
      cron: '30 10 * * *',
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { on: true },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    env.schedule_store.upsertRoutine(routine);

    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });
    expect(await scheduler.tick()).toBe(0);
    expect(env.schedule_store.listFiredForSchedule('r-due')).toEqual([]);

    env.clock.setTo('2026-09-24T10:30:02.000Z');
    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    expect(env.schedule_store.listFiredForSchedule('r-due')).toHaveLength(1);
    expect(env.schedule_store.listFiredForSchedule('r-due')[0]?.status).toBe('dispatched');
  });

  it('fires a local routine only once during the repeated fall-back minute', async () => {
    const env = buildEnv();
    const routine: RoutineTriggerSpec = {
      routine_id: 'fall-back-once',
      name: 'Fall back once',
      cron: '30 1 * * *',
      time_zone: 'America/Chicago',
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { on: false },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    env.schedule_store.upsertRoutine(routine);
    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });

    env.clock.setTo('2026-11-01T06:30:00.000Z');
    expect(await scheduler.tick()).toBe(1);
    env.clock.setTo('2026-11-01T07:30:00.000Z');
    expect(await scheduler.tick()).toBe(0);
    expect(env.schedule_store.listFiredForSchedule('fall-back-once')).toHaveLength(1);
  });

  it('marks a pending occurrence uncertain on restart and never replays it', async () => {
    const env = buildEnv();
    env.clock.setTo('2026-09-24T10:30:15.000Z');
    const routine: RoutineTriggerSpec = {
      routine_id: 'r-uncertain',
      name: 'uncertain',
      cron: '30 10 * * *',
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { on: true },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    env.schedule_store.upsertRoutine(routine);
    const fire_index = Math.floor(new Date('2026-09-24T10:30:00.000Z').getTime() / 60_000);
    const pending = {
      fire_id: `r-uncertain:${fire_index}`,
      schedule_id: 'r-uncertain',
      schedule_kind: 'routine' as const,
      fired_at: '2026-09-24T10:30:00.000Z',
      contract_id: null,
      status: 'pending' as const,
      error: null,
    };
    env.schedule_store.recordFireIfNew(pending);
    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });

    await scheduler.reconcileOnStartup();

    expect(env.schedule_store.listFiredForSchedule('r-uncertain')).toEqual([{
      ...pending,
      status: 'skipped',
      error: 'prior dispatch outcome unknown; recovery suppressed replay',
    }]);
    expect(env.executor.getReceiptsForContract(`sched_r-uncertain-${fire_index}`)).toEqual([]);
  });

  it('does NOT fire a routine whose cron does not match', async () => {
    const env = buildEnv();
    // Cron that never matches (Feb 30 is impossible)
    const routine: RoutineTriggerSpec = {
      routine_id: 'r-impossible',
      name: 'never',
      cron: '0 0 30 2 *', // Feb 30 - impossible
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { on: true },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    env.schedule_store.upsertRoutine(routine);

    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });
    const fired = await scheduler.tick();
    expect(fired).toBe(0);
  });

  it('does NOT fire a disabled routine', async () => {
    const env = buildEnv();
    const routine: RoutineTriggerSpec = {
      routine_id: 'r-disabled',
      name: 'disabled',
      cron: '* * * * *', // every minute
      intent_family: 'set-state',
      target_phrases: ['lamp'],
      desired_values: { on: true },
      exclusions: [],
      role: 'service',
      enabled: false,
    };
    env.schedule_store.upsertRoutine(routine);

    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });
    expect(await scheduler.tick()).toBe(0);
  });

  it('hold past expiry: dispatches a restore and removes the hold', async () => {
    const env = buildEnv();
    // Hold expired 1 hour ago
    const hold = {
      hold_id: 'h-1',
      target_canonical_id: 'dev-living-room-lamp' as any,
      until: new Date(env.clock.now().getTime() - 3600_000).toISOString(),
      restore_behavior: 'restore-previous' as const,
      restore_to: { on: false },
      created_by: 'admin',
      created_at: new Date(env.clock.now().getTime() - 7200_000).toISOString(),
      reason: 'test',
    };
    env.schedule_store.upsertHold(hold);

    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });
    const fired = await scheduler.tick();
    expect(fired).toBeGreaterThanOrEqual(1);
    // Hold should be removed
    expect(env.schedule_store.listActiveHolds(new Date())).toHaveLength(0);
  });

  it('hold NOT past expiry: not fired', async () => {
    const env = buildEnv();
    const hold = {
      hold_id: 'h-2',
      target_canonical_id: 'dev-living-room-lamp' as any,
      until: new Date(env.clock.now().getTime() + 3600_000).toISOString(),
      restore_behavior: 'restore-previous' as const,
      restore_to: null,
      created_by: 'admin',
      created_at: new Date().toISOString(),
      reason: null,
    };
    env.schedule_store.upsertHold(hold);

    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
    });
    expect(await scheduler.tick()).toBe(0);
  });

  it('start()/stop() are idempotent', () => {
    const env = buildEnv();
    const scheduler = new Scheduler({
      store: env.schedule_store,
      executor: env.executor,
      registry: env.hearth_registry,
      executor_registry: env.executor_registry,
      clock: env.clock,
      tick_seconds: 60,
    });
    scheduler.start();
    scheduler.start(); // no-op
    scheduler.stop();
    scheduler.stop(); // no-op
    expect(true).toBe(true);
  });
});

describe('vi spy sanity check', () => {
  it('vi.fn() works', () => {
    const fn = vi.fn();
    fn('hi');
    expect(fn).toHaveBeenCalledWith('hi');
  });
});
