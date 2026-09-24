/**
 * Test helpers: in-memory adapter that records dispatched values and lets
 * tests script state changes. Plus a deterministic clock.
 */

import type {
  CanonicalId,
  HomeAssistantAdapter,
  StateHandler,
  StateObservation,
  UnsubscribeableSubscription,
  ContractTarget,
  DispatchAck,
} from '@hearth/contracts';
import type { Clock } from '../src/index.js';

export class FixedClock implements Clock {
  private current: Date;
  public constructor(initial: Date | string) {
    this.current = typeof initial === 'string' ? new Date(initial) : new Date(initial.getTime());
  }
  public now(): Date {
    return new Date(this.current.getTime());
  }
  public nowIso(): string {
    return this.current.toISOString();
  }
  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  public setTo(iso: string): void {
    this.current = new Date(iso);
  }
}

export interface DispatchedCall {
  target: ContractTarget;
  desired_values: Readonly<Record<string, number | string | boolean>>;
}

export class FakeAdapter implements HomeAssistantAdapter {
  public readonly dispatched: DispatchedCall[] = [];
  public suppressAutoStateOnDispatch = false;
  private readonly states = new Map<CanonicalId, StateObservation>();
  private readonly handlers = new Map<CanonicalId, Set<StateHandler>>();
  private versionCounter = new Map<CanonicalId, number>();

  public setState(
    canonical_id: CanonicalId,
    values: Record<string, number | string | boolean>,
    opts: { observed_at?: string; source?: StateObservation['source'] } = {},
  ): StateObservation {
    const prev_version = this.versionCounter.get(canonical_id) ?? 0;
    const next_version = prev_version + 1;
    this.versionCounter.set(canonical_id, next_version);
    const obs: StateObservation = {
      canonical_id,
      observed_at: opts.observed_at ?? new Date().toISOString(),
      source: opts.source ?? 'fresh-poll',
      values,
      state_version: next_version,
    };
    this.states.set(canonical_id, obs);
    const handlers = this.handlers.get(canonical_id);
    if (handlers) {
      for (const h of handlers) h(obs);
    }
    return obs;
  }

  public setVersion(canonical_id: CanonicalId, version: number): void {
    this.versionCounter.set(canonical_id, version);
    const existing = this.states.get(canonical_id);
    if (existing) {
      this.states.set(canonical_id, { ...existing, state_version: version });
    }
  }

  public listDevices(): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }
  public listRooms(): Promise<ReadonlyArray<never>> {
    return Promise.resolve([]);
  }
  public getState(canonical_id: CanonicalId): Promise<StateObservation> {
    const obs = this.states.get(canonical_id);
    if (!obs) {
      return Promise.reject(new Error(`no state for ${canonical_id}`));
    }
    return Promise.resolve(obs);
  }
  public dispatch(
    target: ContractTarget,
    desired_values: Readonly<Record<string, number | string | boolean>>,
  ): Promise<DispatchAck> {
    this.dispatched.push({ target, desired_values });
    // Real HA reflects the dispatched value into state when the device
    // acknowledges; the fake adapter simulates that so the watcher can
    // observe the change. Tests that need to exercise the
    // optimistic-only / failed-with-no-evidence path can opt out via
    // suppressAutoStateOnDispatch=true.
    if (!this.suppressAutoStateOnDispatch) {
      this.setState(target.canonical_id, { ...desired_values });
    }
    return Promise.resolve({
      kind: 'sent',
      provider: 'fake-ha',
      echoed_at: new Date().toISOString(),
    });
  }
  public subscribe(
    canonical_ids: ReadonlyArray<CanonicalId>,
    handler: StateHandler,
  ): UnsubscribeableSubscription {
    for (const id of canonical_ids) {
      let set = this.handlers.get(id);
      if (!set) {
        set = new Set();
        this.handlers.set(id, set);
      }
      set.add(handler);
    }
    return {
      unsubscribe: () => {
        for (const id of canonical_ids) {
          this.handlers.get(id)?.delete(handler);
        }
      },
    };
  }
}