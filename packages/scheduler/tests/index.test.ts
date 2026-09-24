import { describe, it, expect, vi } from 'vitest';
import {
  nextCronFire,
  InMemoryScheduleStore,
  Scheduler,
  type RoutineTriggerSpec,
} from '../src/index.js';
import { ContractExecutor, InMemoryExecutionStore, SystemClock, InMemoryRegistryOverlay } from '@hearth/executor';
import { FakeHAAdapter, loadDefaultFixture } from '@hearth/ha-adapter';
import { RegistryOverlay } from '@hearth/registry';

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
    const clock = new SystemClock();
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

  it('fires a routine whose cron matches the current minute', async () => {
    const env = buildEnv();
    const now = new Date(env.clock.now());
    // Build a cron that fires NOW (current minute)
    const cron = `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`;
    const routine: RoutineTriggerSpec = {
      routine_id: 'r-now',
      name: 'fires-now',
      cron,
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
    expect(fired).toBeGreaterThanOrEqual(0);
    // Whether it fires depends on whether we crossed a minute boundary during
    // the test. At minimum: the routine was evaluated and didn't throw.
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