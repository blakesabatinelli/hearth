import React from 'react';
import type { DevicesResponse, HearthApi, RoutineRecord } from '../api';

type State = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly routines: ReadonlyArray<RoutineRecord>; readonly devices: DevicesResponse } | { readonly kind: 'error'; readonly message: string };

export function Routines({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [name, setName] = React.useState('');
  const [time, setTime] = React.useState('08:00');
  const [targetId, setTargetId] = React.useState('');
  const [on, setOn] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  const timeZone = React.useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  React.useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    Promise.all([api.listRoutines(), api.listDevices()])
      .then(([routines, devices]) => {
        if (!active) return;
        setState({ kind: 'ready', routines, devices });
        setTargetId((current) => current || devices.devices.find((device) => device.control_enabled && device.load_type === 'light')?.canonical_id || '');
      })
      .catch((error: Error) => { if (active) setState({ kind: 'error', message: error.message }); });
    return () => { active = false; };
  }, [api, refresh]);

  const reload = (): void => setRefresh((value) => value + 1);
  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !targetId) return;
    setBusy(true);
    setMessage('');
    try {
      await api.createRoutine({ name: name.trim(), time_local: time, time_zone: timeZone, target_canonical_id: targetId, on });
      setName('');
      setMessage('Routine saved. It runs through Hearth’s executor at the next matching local time.');
      reload();
    } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const setEnabled = async (routine: RoutineRecord): Promise<void> => {
    setBusy(true);
    try { await api.setRoutineEnabled(routine.routine_id, !routine.enabled); reload(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (routine: RoutineRecord): Promise<void> => {
    setBusy(true);
    try { await api.deleteRoutine(routine.routine_id); setMessage(`Removed ${routine.name}.`); reload(); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };

  if (state.kind === 'loading') return <section aria-label="routines"><h2>Routines</h2><p className="muted">Loading saved routines…</p></section>;
  if (state.kind === 'error') return <section aria-label="routines"><h2>Routines</h2><p className="error" role="alert">Could not load routines: {state.message}</p></section>;

  const eligible = state.devices.devices.filter((device) => device.control_enabled && device.load_type === 'light' && device.capabilities.includes('on-off'));
  const deviceNames = new Map(state.devices.devices.map((device) => [device.canonical_id, device.friendly_name]));

  return (
    <section aria-label="routines" className="screen-stack">
      <header className="screen-heading"><div><p className="eyebrow">Saved schedules</p><h2>Routines</h2><p className="muted">Routines do not need OpenClaw or Bonsai. Each run goes through Hearth’s scheduler and executor.</p></div><button type="button" className="secondary-button" onClick={reload}>Refresh</button></header>
      <form className="routine-form" onSubmit={(event) => void save(event)}>
        <h3>Create a daily light routine</h3>
        {eligible.length === 0 ? <p className="muted">No devices are currently approved for scheduled lighting.</p> : (
          <>
            <label>Routine name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Wake up" required /></label>
            <div className="routine-form-grid">
              <label>Light<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{eligible.map((device) => <option key={device.canonical_id} value={device.canonical_id}>{device.friendly_name}</option>)}</select></label>
              <label>Set state<select value={on ? 'on' : 'off'} onChange={(event) => setOn(event.target.value === 'on')}><option value="on">On</option><option value="off">Off</option></select></label>
              <label>Every day at <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
            </div>
            <p className="muted">Time zone: <code>{timeZone}</code>. A local time skipped by spring-forward will not run that day. A repeated fall-back time runs once.</p>
            <button type="submit" className="primary-button" disabled={busy || !name.trim() || !targetId}>{busy ? 'Saving…' : 'Save routine'}</button>
          </>
        )}
        {message && <p className="inline-message" role="status">{message}</p>}
      </form>
      <section className="attention-section"><h3>Saved routines</h3>
        {state.routines.length === 0 ? <div className="empty-state"><p>No routines saved yet.</p></div> : <ul className="routine-list">{state.routines.map((routine) => (
          <li className="routine-card" key={routine.routine_id}>
            <div className="routine-card-main"><div><strong>{routine.name}</strong><span className="muted">Daily at {routine.cron.split(' ')[1]?.padStart(2, '0')}:{routine.cron.split(' ')[0]?.padStart(2, '0')} · {routine.time_zone ?? 'UTC'}</span><span className="muted">{routine.desired_values.on === true ? 'Turn on' : 'Turn off'} {routine.target_phrases.map((id) => deviceNames.get(id) ?? id).join(', ')}</span></div><span className={routine.enabled ? 'status-pill confirmed' : 'status-pill muted-pill'}>{routine.enabled ? 'Active' : 'Paused'}</span></div>
            <div className="routine-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void setEnabled(routine)}>{routine.enabled ? 'Pause' : 'Resume'}</button><button type="button" className="danger-button" disabled={busy} onClick={() => void remove(routine)}>Remove</button></div>
            {routine.recent_fires.length > 0 && <details><summary>Recent runs</summary><ul className="route-list">{routine.recent_fires.map((fire, index) => <li key={`${fire.fired_at}-${index}`}><span>{new Date(fire.fired_at).toLocaleString()}</span><span>{fire.status}{fire.error ? ` · ${fire.error}` : ''}</span></li>)}</ul></details>}
          </li>
        ))}</ul>}
      </section>
    </section>
  );
}
