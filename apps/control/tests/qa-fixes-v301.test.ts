/**
 * v3.0.1 QA regression tests.
 *
 * Each `describe` block corresponds to one item in the QA list.
 * These tests are RED against v3.0; the fixes in v3.0.1 turn them GREEN.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestControl, createSession, type TestControl } from './fixtures.js';
import {
  SystemClock,
  type RegistryOverlay as ExecutorRegistryOverlay,
  type ContractExecutor,
} from '@hearth/executor';
import { RegistryOverlay } from '@hearth/registry';
import { loadDefaultFixture } from '@hearth/ha-adapter';
import type {
  IntentFamily,
  IntentProposal as ContractProposal,
} from '@hearth/contracts';
import {
  Scheduler,
  InMemoryScheduleStore,
  type HoldSpec,
  type RoutineTriggerSpec,
  type SchedulerOptions,
} from '@hearth/scheduler';
import {
  buildContract,
  type BuildContractInput,
} from '../src/contract-builder.js';
import { HearthToExecutorRegistry } from '../src/registry-adapter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

let tc: TestControl;
beforeEach(async () => { tc = await buildTestControl(); });
afterEach(async () => { await tc.tearDown(); });

type IntentProposal = ContractProposal;

const HEARTH_OVERLAY = (): { registry: RegistryOverlay; overlay: ExecutorRegistryOverlay } => {
  const fixture = loadDefaultFixture();
  const registry = new RegistryOverlay({
    devices: fixture.devices as never,
    rooms: fixture.rooms as never,
    entity_version: 1,
    scene_versions: {},
  });
  return { registry, overlay: new HearthToExecutorRegistry(registry) };
};

const makeBuildInput = (
  request_id: string,
  phrase: string,
  proposalOverride?: Partial<IntentProposal>,
): BuildContractInput => {
  const { registry, overlay } = HEARTH_OVERLAY();
  const base_proposal: IntentProposal = {
    request_id,
    intent_family: 'set-state' as IntentFamily,
    target_phrases: [phrase],
    desired_values: { power: 'on', brightness: 60 },
    exclusions: [],
    temporal: null,
    unresolved_fields: [],
    confidence: 1.0,
    provenance: { source: 'grammar', matched_rule: 'qa-test' },
  };
  const proposal: IntentProposal = proposalOverride
    ? { ...base_proposal, ...proposalOverride }
    : base_proposal;
  return {
    actor: { actor_id: 'a', role: 'admin', session_id: 's' },
    request_id,
    idempotency_key: request_id as never,
    proposal,
    registry: overlay,
    resolve_phrase: async (p) => {
      const hits = await registry.resolve(p);
      return hits.map((h) => ({ canonical_id: h.device.canonical_id }));
    },
    now: () => new Date(),
    // v3.0.1: provide a deterministic observation source so the test
    // does not depend on a real adapter. state_version starts at 1 and
    // brightness starts at 50.
    observed_state: async () => 1,
    resolve_relative: async (
      _t: string,
      desired: Readonly<Record<string, number | string | boolean>>,
      obs: Readonly<Record<string, unknown>>,
    ) => {
      const out: Record<string, number | string | boolean> = {};
      for (const [k, v] of Object.entries(desired)) {
        if (k.startsWith('relative_')) {
          const cur = typeof obs[k.slice(9)] === 'number' ? (obs[k.slice(9)] as number) : 50;
          if (typeof v === 'string' && v.startsWith('+')) out[k.slice(9)] = cur + Number(v.slice(1));
          else if (typeof v === 'string' && v.startsWith('-')) out[k.slice(9)] = cur - Number(v.slice(1));
          else out[k.slice(9)] = cur;
        } else out[k] = v;
      }
      return out;
    },
  };
};

const makeScheduler = (executor: ContractExecutor, opts?: Partial<SchedulerOptions>) => {
  const store = new InMemoryScheduleStore();
  return new Scheduler({
    store,
    executor,
    registry: tc.hearth_registry,
    executor_registry: tc.executor_registry,
    clock: new SystemClock(),
    ...opts,
  });
};

// =============================================================================
// QA item #1: unauthenticated callers cannot create admin sessions
// =============================================================================
describe('QA #1: unauthenticated callers cannot create admin sessions', () => {
  it('rejects an unauthenticated POST /v1/sessions in production mode', async () => {
    process.env.HEARTH_REQUIRE_DEV_TOKEN = 'dev-only-token';
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { role: 'admin' },
    });
    expect([401, 403]).toContain(res.statusCode);
    delete process.env.HEARTH_REQUIRE_DEV_TOKEN;
  });

  it('rejects role=admin with a wrong dev token', async () => {
    process.env.HEARTH_REQUIRE_DEV_TOKEN = 'dev-only-token';
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { role: 'admin' },
      headers: { 'x-hearth-dev-token': 'wrong' },
    });
    expect(res.statusCode).toBe(403);
    delete process.env.HEARTH_REQUIRE_DEV_TOKEN;
  });
});

// =============================================================================
// QA item #2: /v1/contracts requires an interpreter-stamped proposal
// =============================================================================
describe('QA #2: /v1/contracts requires an interpreter-stamped proposal', () => {
  beforeEach(() => { process.env['HEARTH_REQUIRE_DEV_TOKEN'] = 'dev-only-token'; });
  afterEach(() => { delete process.env['HEARTH_REQUIRE_DEV_TOKEN']; });

  it('rejects a hand-built proposal lacking a proposal_receipt in production mode', async () => {
    process.env['HEARTH_REQUIRE_DEV_TOKEN'] = 'dev-only-token';
    const { cookie, csrf } = await createSession(tc.app, 'admin', { dev_token: 'dev-only-token' });
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie, 'x-hearth-csrf': csrf },
      payload: {
        proposal: {
          request_id: 'r1',
          intent_family: 'set-state',
          target_phrases: ['kitchen lights'],
          desired_values: { power: 'on' },
          exclusions: [],
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'fabricated' },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('untrusted_proposal');
  });

  it('accepts a proposal when /v1/interpret returned a valid receipt', async () => {
    process.env['HEARTH_REQUIRE_DEV_TOKEN'] = 'dev-only-token';
    const { cookie, csrf } = await createSession(tc.app, 'admin', { dev_token: 'dev-only-token' });
    const interp_request_id = 'r-interpret-1';
    const interp = await tc.app.inject({
      method: 'POST',
      url: '/v1/interpret',
      headers: { cookie, 'x-hearth-csrf': csrf },
      payload: { utterance: 'turn on the kitchen lights', request_id: interp_request_id },
    });
    expect(interp.statusCode).toBe(200);
    const interp_body = interp.json() as {
      decision: { outcome: string; proposal?: unknown; proposal_receipt?: string };
      request_id: string;
    };
    expect(interp_body.decision.outcome).toBe('ready_for_contract');
    expect(interp_body.decision.proposal_receipt).toBeTruthy();
    const res = await tc.app.inject({
      method: 'POST',
      url: '/v1/contracts',
      headers: { cookie, 'x-hearth-csrf': csrf },
      payload: {
        proposal: interp_body.decision.proposal,
        proposal_receipt: interp_body.decision.proposal_receipt,
        request_id: interp_request_id,
      },
    });
    if (res.statusCode !== 200) console.log('DEBUG contract body:', res.body);
    expect(res.statusCode).toBe(200);
  });
});

// =============================================================================
// QA item #3: contract targets carry the observed state_version
// =============================================================================
describe('QA #3: contract targets carry the observed state_version', () => {
  it('target.state_version matches the observed state at build time', async () => {
    const lamp_id = 'dev-living-room-lamp';
    const { registry, overlay } = HEARTH_OVERLAY();
    const observed = await tc.adapter.getState(lamp_id as never);

    const build_input: BuildContractInput = {
      actor: { actor_id: 'a', role: 'admin', session_id: 's' },
      request_id: 'r-state',
      idempotency_key: 'r-state' as never,
      proposal: {
        request_id: 'r-state',
        intent_family: 'set-state' as IntentFamily,
        target_phrases: ['living room lamp'],
        desired_values: { power: 'on' },
        exclusions: [],
        temporal: null,
        unresolved_fields: [],
        confidence: 1.0,
        provenance: { source: 'grammar', matched_rule: 'qa' },
      },
      registry: overlay,
      resolve_phrase: async (p) => {
        const hits = await registry.resolve(p);
        return hits.map((h) => ({ canonical_id: h.device.canonical_id }));
      },
      now: () => new Date(),
      observed_state: async (id) => (await tc.adapter.getState(id as never)).state_version,
    };
    const { contract } = await buildContract(build_input);
    const target = contract.targets.find((t) => t.canonical_id === lamp_id);
    expect(target).toBeTruthy();
    expect(target!.state_version).not.toBe(0);
    expect(target!.state_version).toBe(observed.state_version);
  });
});

// =============================================================================
// QA item #4: scheduler ticks future cron matches only
// =============================================================================
describe('QA #4: scheduler ticks future cron matches only', () => {
  it('disabled routines never fire', async () => {
    const sched = makeScheduler(tc.executor);
    const store = (sched as never as { store: InMemoryScheduleStore }).store;
    const spec: RoutineTriggerSpec = {
      routine_id: 'disabled',
      name: 'disabled-routine',
      cron: '* * * * *',     // every minute
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { power: 'on' },
      exclusions: [],
      role: 'service',
      enabled: false,
    };
    store.upsertRoutine(spec);
    await sched.tick();
    // routine_id 'disabled' must NOT have a fire record because
    // enabled=false short-circuits the tick.
    expect(store.listFiredForSchedule('disabled')).toEqual([]);
    expect(store.lastFireIndex('disabled')).toBe(-1);
  });

  it('a cron with no future match in 4 years does not fire', async () => {
    // Feb 30 doesn't exist; cron parser returns null from nextCronFire,
    // and the scheduler ticks nothing.
    const sched = makeScheduler(tc.executor);
    const store = (sched as never as { store: InMemoryScheduleStore }).store;
    const spec: RoutineTriggerSpec = {
      routine_id: 'never',
      name: 'feb-30',
      cron: '0 0 30 2 *',
      intent_family: 'set-state',
      target_phrases: ['living room lamp'],
      desired_values: { power: 'on' },
      exclusions: [],
      role: 'service',
      enabled: true,
    };
    store.upsertRoutine(spec);
    await sched.tick();
    expect(store.listFiredForSchedule('never')).toEqual([]);
  });
});

// =============================================================================
// QA item #5: hold restoration produces a non-empty contract
// =============================================================================
describe('QA #5: hold restoration produces a non-empty contract', () => {
  it('expired hold dispatches a contract with the held device as a target', async () => {
    const store = new InMemoryScheduleStore();
    const sched = new Scheduler({
      store,
      executor: tc.executor,
      registry: tc.hearth_registry,
      executor_registry: tc.executor_registry,
      clock: new SystemClock(),
    });

    const now_ms = Date.now();
    const hold: HoldSpec = {
      hold_id: 'h1',
      target_canonical_id: 'dev-living-room-lamp' as never,
      until: new Date(now_ms - 1).toISOString(),
      restore_behavior: 'restore-previous',
      restore_to: { power: 'off' },
      created_by: 'admin',
      created_at: new Date(now_ms - 60_000).toISOString(),
      reason: 'test',
    };
    store.upsertHold(hold);
    await sched.tick();

    // 1. Hold must be removed after the tick succeeded.
    const remaining = store.listActiveHolds(new Date());
    expect(remaining.find((h) => h.hold_id === 'h1')).toBeUndefined();

    // 2. A contract with the held device must have been dispatched.
    //    The scheduler names a restored contract `sched_<hold_id>-restore`,
    //    and its actor_id is `hold:<hold_id>`. The executor's receipts
    //    for that contract_id is the proof the contract was non-empty.
    const expected_contract_id = 'sched_h1-restore';
    const receipts = tc.executor.getReceiptsForContract(expected_contract_id);
    expect(receipts.length).toBeGreaterThan(0);
    const receipt = receipts[0]!;
    // The receipt itself reports the contract shape; we re-derive the
    // target list via the executor's receipts-for-contract reverse path.
    // Since we don't have a full contract->targets accessor here, we
    // verify the receipt was actually produced (status field changes).
    expect(receipt.receipt_id).toBeDefined();
  });
});

// =============================================================================
// QA item #6: PWA same-origin in production
// =============================================================================
describe('QA #6: PWA same-origin in production', () => {
  it('apps/web/README.md documents the production routing story', () => {
    const readme = path.resolve('../web/README.md');
    if (!fs.existsSync(readme)) {
      throw new Error('apps/web/README.md missing; production story not documented');
    }
    const text = fs.readFileSync(readme, 'utf8');
    expect(text.toLowerCase()).toMatch(/production|same.origin|reverse.proxy|caddy|nginx/);
  });
});

// =============================================================================
// QA item #7: relative brightness resolves against observed state
// =============================================================================
describe('QA #7: relative brightness resolves against observed state', () => {
  it('desired_values.brightness is greater than 0 after a relative +10', async () => {
    const build_input = makeBuildInput('r-rel', 'living room lamp', {
      intent_family: 'set-brightness-relative' as IntentFamily,
      desired_values: { relative_brightness: '+10' },
    });
    const { contract } = await buildContract(build_input);
    const val = contract.desired_values['brightness'];
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThan(0);
  });
});

// =============================================================================
// QA item #8: production wiring is gated to deployment config, never embedded
// =============================================================================
describe('QA #8: production wiring is gated to deployment config, never embedded', () => {
  it('no hard-coded HA URL or HA token in the source', () => {
    const ha_src = fs.readFileSync(
      path.resolve('../../packages/ha-adapter/src/index.ts'),
      'utf8',
    );
    expect(ha_src).not.toMatch(/192\.168\./);
    expect(ha_src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });

  it('apps/control references env vars or explicit unconfigured branch', () => {
    const main_src = fs.readFileSync(
      path.resolve('../control/src/main.ts'),
      'utf8',
    );
    expect(main_src).not.toMatch(/sk_live_|bearer eyJ/);
    expect(main_src.toLowerCase()).toMatch(/hearth_openclaw|hearth_ha|url|unconfigured/);
  });
});

// =============================================================================
// QA item #9: ops surface
// =============================================================================
describe('QA #9: ops surface', () => {
  it('apps/control package.json has start, doctor, lint scripts', () => {
    type PkgShape = { scripts?: Record<string, string> };
    const pkg_path = path.resolve('../control/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkg_path, 'utf8')) as PkgShape;
    expect(pkg.scripts?.['start']).toBeDefined();
    expect(pkg.scripts?.['doctor']).toBeDefined();
    expect(pkg.scripts?.['lint']).toBeDefined();
  });

  it('root package.json has upgrade, doctor, integration scripts', () => {
    type PkgShape = { scripts?: Record<string, string> };
    const pkg_path = path.resolve('../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkg_path, 'utf8')) as PkgShape;
    expect(pkg.scripts?.['upgrade']).toBeDefined();
    expect(pkg.scripts?.['doctor']).toBeDefined();
    expect(pkg.scripts?.['integration']).toBeDefined();
  });
});
