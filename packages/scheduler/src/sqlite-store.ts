import type { FireRecord, HoldSpec, RoutineTriggerSpec, ScheduleStore } from './index.js';
import { cronMatchesAtMinuteInTimeZone } from './cron.js';

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hearth_routines (
  routine_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hearth_holds (
  hold_id TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hearth_holds_until ON hearth_holds(until);

CREATE TABLE IF NOT EXISTS hearth_schedule_fires (
  schedule_id TEXT NOT NULL,
  fire_id TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('routine', 'hold')),
  fired_at TEXT NOT NULL,
  contract_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'failed', 'skipped')),
  error TEXT,
  PRIMARY KEY (schedule_id, fire_id)
);
CREATE INDEX IF NOT EXISTS idx_hearth_schedule_fires_time
  ON hearth_schedule_fires(schedule_id, fired_at);
`;

type FireRow = {
  schedule_id: string;
  fire_id: string;
  schedule_kind: FireRecord['schedule_kind'];
  fired_at: string;
  contract_id: string | null;
  status: FireRecord['status'];
  error: string | null;
};

export type SqliteScheduleStoreOptions = {
  /** The caller owns the SQLite connection and its lifetime. */
  readonly db: import('better-sqlite3').Database;
};

/** SQLite-backed schedule storage. The database path is chosen by the caller. */
export class SqliteScheduleStore implements ScheduleStore {
  private readonly db: import('better-sqlite3').Database;

  public constructor(opts: SqliteScheduleStoreOptions) {
    this.db = opts.db;
    this.db.exec(SQLITE_SCHEMA);
  }

  public upsertRoutine(routine: RoutineTriggerSpec): void {
    this.db.prepare(`
      INSERT INTO hearth_routines (routine_id, payload_json)
      VALUES (?, ?)
      ON CONFLICT(routine_id) DO UPDATE SET payload_json = excluded.payload_json
    `).run(routine.routine_id, JSON.stringify(routine));
  }

  public listRoutines(): ReadonlyArray<RoutineTriggerSpec> {
    const rows = this.db.prepare(
      'SELECT payload_json FROM hearth_routines ORDER BY rowid',
    ).all() as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as RoutineTriggerSpec);
  }

  public removeRoutine(routine_id: string): void {
    this.db.prepare('DELETE FROM hearth_routines WHERE routine_id = ?').run(routine_id);
  }

  public upsertHold(hold: HoldSpec): void {
    this.db.prepare(`
      INSERT INTO hearth_holds (hold_id, until, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(hold_id) DO UPDATE SET
        until = excluded.until,
        payload_json = excluded.payload_json
    `).run(hold.hold_id, hold.until, JSON.stringify(hold));
  }

  public listActiveHolds(now: Date): ReadonlyArray<HoldSpec> {
    return this.listHolds('until > ?', now.toISOString());
  }

  public removeHold(hold_id: string): void {
    this.db.prepare('DELETE FROM hearth_holds WHERE hold_id = ?').run(hold_id);
  }

  public recordFireIfNew(fire: FireRecord): boolean {
    const result = this.db.prepare(`
      INSERT INTO hearth_schedule_fires
        (schedule_id, fire_id, schedule_kind, fired_at, contract_id, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(schedule_id, fire_id) DO NOTHING
    `).run(
      fire.schedule_id,
      fire.fire_id,
      fire.schedule_kind,
      fire.fired_at,
      fire.contract_id,
      fire.status,
      fire.error,
    );
    return result.changes === 1;
  }

  public updateFire(fire: FireRecord): boolean {
    const result = this.db.prepare(`
      UPDATE hearth_schedule_fires
      SET fired_at = ?, contract_id = ?, status = ?, error = ?
      WHERE schedule_id = ? AND fire_id = ?
    `).run(
      fire.fired_at,
      fire.contract_id,
      fire.status,
      fire.error,
      fire.schedule_id,
      fire.fire_id,
    );
    return result.changes === 1;
  }

  public listFiredForSchedule(schedule_id: string): ReadonlyArray<FireRecord> {
    const rows = this.db.prepare(`
      SELECT schedule_id, fire_id, schedule_kind, fired_at, contract_id, status, error
      FROM hearth_schedule_fires
      WHERE schedule_id = ?
      ORDER BY fired_at, fire_id
    `).all(schedule_id) as FireRow[];
    return rows.map((row) => ({ ...row }));
  }

  public lastFireIndex(schedule_id: string): number {
    const indices = this.listFiredForSchedule(schedule_id)
      .map((fire) => Number(fire.fire_id.slice(fire.fire_id.lastIndexOf(':') + 1)))
      .filter(Number.isFinite);
    return indices.length > 0 ? Math.max(...indices) : -1;
  }

  public routinesToEvaluate(now: Date): ReadonlyArray<RoutineTriggerSpec> {
    return this.listRoutines().filter(
      (routine) => routine.enabled && cronMatchesAtMinuteInTimeZone(routine.cron, now, routine.time_zone ?? 'UTC'),
    );
  }

  public holdsPastExpiry(now: Date): ReadonlyArray<HoldSpec> {
    return this.listHolds('until <= ?', now.toISOString());
  }

  private listHolds(predicate: 'until > ?' | 'until <= ?', value: string): ReadonlyArray<HoldSpec> {
    const rows = this.db.prepare(`
      SELECT payload_json FROM hearth_holds WHERE ${predicate} ORDER BY until, hold_id
    `).all(value) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as HoldSpec);
  }
}
