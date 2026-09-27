import React from 'react';
import type { HearthApi, DevicesResponse, DeviceState, DirectControlResponse } from '../api';

type LoadState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'error'; readonly message: string };

type ControlState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'result'; readonly aggregate: string; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

function receiptAggregate(result: DirectControlResponse): string {
  if (typeof result.receipt !== 'object' || result.receipt === null) return 'unknown';
  const aggregate = (result.receipt as Record<string, unknown>).aggregate;
  return typeof aggregate === 'string' ? aggregate : 'unknown';
}

function aggregateMessage(aggregate: string): string {
  switch (aggregate) {
    case 'confirmed': return 'Confirmed by Home Assistant.';
    case 'no-op': return 'Already in that state. No device command was sent.';
    case 'partial': return 'Only some requested targets completed. Check the receipt.';
    case 'sent-unconfirmed': return 'Command sent. Hearth has not confirmed the new state yet.';
    case 'failed': return 'The device did not confirm the command.';
    case 'expired': return 'The command expired before it ran.';
    default: return 'Hearth returned an outcome that needs review.';
  }
}

function observedOn(state: LoadState<DeviceState> | undefined): boolean | null {
  if (state?.kind !== 'ok') return null;
  const value = state.data.state.values.on;
  return typeof value === 'boolean' ? value : null;
}

function observedLabel(state: LoadState<DeviceState> | undefined): string {
  const on = observedOn(state);
  if (on === true) return 'On';
  if (on === false) return 'Off';
  if (state?.kind === 'loading' || state?.kind === 'idle' || !state) return 'Checking';
  return state.kind === 'error' ? 'Unavailable' : 'State unknown';
}

/**
 * iPad-first room and device view. A direct tap submits a narrowly scoped
 * server request; the control service builds a contract and the executor
 * alone performs device actuation.
 */
const FAVORITES_KEY = 'hearth.favorite_device_ids';

export function Home({ api, title = 'Rooms & devices', favoritesOnly = false }: {
  readonly api: HearthApi;
  readonly title?: string;
  readonly favoritesOnly?: boolean;
}): React.ReactElement {
  const [list, setList] = React.useState<LoadState<DevicesResponse>>({ kind: 'idle' });
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [stateById, setStateById] = React.useState<Record<string, LoadState<DeviceState>>>({});
  const [controlById, setControlById] = React.useState<Record<string, ControlState>>({});
  const [refresh, setRefresh] = React.useState(0);
  const [favorites, setFavorites] = React.useState<ReadonlySet<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as string[]); }
    catch { return new Set(); }
  });
  const [selectedRoom, setSelectedRoom] = React.useState('all');

  React.useEffect(() => {
    let active = true;
    setList({ kind: 'loading' });
    setStateById({});
    setControlById({});
    api.listDevices().then(async (data) => {
      if (!active) return;
      setList({ kind: 'ok', data });
      const controllable = data.devices.filter((device) => device.control_enabled && device.load_type === 'light');
      const observations = await Promise.all(controllable.map(async (device) => {
        try { return [device.canonical_id, { kind: 'ok', data: await api.getDeviceState(device.canonical_id) } as LoadState<DeviceState>] as const; }
        catch (error) { return [device.canonical_id, { kind: 'error', message: (error as Error).message } as LoadState<DeviceState>] as const; }
      }));
      if (active) setStateById(Object.fromEntries(observations));
    }).catch((error: Error) => {
      if (active) setList({ kind: 'error', message: error.message });
    });
    return () => { active = false; };
  }, [api, refresh]);

  const openDevice = (id: string): void => {
    setOpenId(id);
    if (stateById[id]?.kind === 'ok' || stateById[id]?.kind === 'loading') return;
    setStateById((prev) => ({ ...prev, [id]: { kind: 'loading' } }));
    setControlById((prev) => prev[id]?.kind === 'error' ? { ...prev, [id]: { kind: 'idle' } } : prev);
    api.getDeviceState(id)
      .then((data) => setStateById((prev) => ({ ...prev, [id]: { kind: 'ok', data } })))
      .catch((err: Error) => setStateById((prev) => ({ ...prev, [id]: { kind: 'error', message: err.message } })));
  };

  const controlDevice = async (id: string, on: boolean): Promise<void> => {
    setControlById((prev) => ({ ...prev, [id]: { kind: 'sending' } }));
    try {
      const result = await api.controlDevice(id, on);
      const aggregate = receiptAggregate(result);
      setControlById((prev) => ({ ...prev, [id]: { kind: 'result', aggregate, message: aggregateMessage(aggregate) } }));
      if (aggregate === 'confirmed' || aggregate === 'no-op') {
        try {
          const fresh = await api.getDeviceState(id);
          setStateById((prev) => ({ ...prev, [id]: { kind: 'ok', data: fresh } }));
        } catch (error) {
          setStateById((prev) => ({ ...prev, [id]: { kind: 'error', message: (error as Error).message } }));
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      setStateById((prev) => ({ ...prev, [id]: { kind: 'error', message: 'Control outcome is unknown. Refresh device state before retrying.' } }));
      setControlById((prev) => ({ ...prev, [id]: { kind: 'error', message: `${message}. The tap was not retried; refresh device state before retrying.` } }));
    }
  };

  if (list.kind === 'loading' || list.kind === 'idle') return <p className="muted">Loading your home…</p>;
  if (list.kind === 'error') return <div className="error" role="alert">Could not load Home Assistant devices: {list.message}</div>;

  const { devices, rooms } = list.data;
  const favoriteDevices = devices.filter((device) => favorites.has(device.canonical_id));
  const filteredDevices = devices.filter((device) => {
    if (favoritesOnly && !favorites.has(device.canonical_id)) return false;
    if (selectedRoom !== 'all' && (device.room_id ?? '__unassigned__') !== selectedRoom) return false;
    return true;
  });
  const roomById = new Map(rooms.map((room) => [room.room_id, room.name]));
  const grouped = new Map<string, typeof devices[number][]>();
  for (const room of rooms) grouped.set(room.room_id, []);
  grouped.set('__unassigned__', []);
  for (const device of filteredDevices) {
    const key = device.room_id && grouped.has(device.room_id) ? device.room_id : '__unassigned__';
    grouped.get(key)?.push(device);
  }
  const readyCount = devices.filter((device) => device.control_enabled).length;
  const toggleFavorite = (id: string): void => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id); else next.add(id);
    setFavorites(next);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])); } catch { /* device storage can be unavailable */ }
  };

  return (
    <section aria-label={favoritesOnly ? 'favorites' : 'rooms'} className="home-screen">
      <header className="home-overview">
        <div>
          <p className="eyebrow">Your home</p>
          <h2>{title}</h2>
          <p className="muted">{readyCount} ready to control <span aria-hidden="true">·</span> {devices.length} discovered <span aria-hidden="true">·</span> {rooms.length} rooms</p>
        </div>
        <button type="button" className="refresh-button" onClick={() => setRefresh((value) => value + 1)} aria-label="Refresh device states">Refresh</button>
      </header>

      <div className="collection-tools">
        {favoritesOnly ? <p className="muted">Favorites are saved on this device.</p> : (
          <label className="room-filter">Show room
            <select value={selectedRoom} onChange={(event) => setSelectedRoom(event.target.value)} aria-label="Filter by room">
              <option value="all">All rooms</option>
              {rooms.map((room) => <option key={room.room_id} value={room.room_id}>{room.name}</option>)}
              <option value="__unassigned__">Unassigned</option>
            </select>
          </label>
        )}
        {!favoritesOnly && <p className="muted">{favoriteDevices.length} favorites</p>}
      </div>

      {devices.length === 0 ? (
        <p className="muted" role="status">No supported devices were found in Home Assistant. Check its integrations, then refresh.</p>
      ) : filteredDevices.length === 0 ? (
        <div className="empty-state"><h3>{favoritesOnly ? 'No favorites yet' : 'No devices in this room'}</h3><p>{favoritesOnly ? 'Use the star button on a device to add it here.' : 'Choose another room to see its devices.'}</p></div>
      ) : (
        <div className="rooms-grid">
          {Array.from(grouped.entries()).map(([roomId, items]) => {
            if (items.length === 0) return null;
            const label = roomId === '__unassigned__' ? 'Unassigned' : (roomById.get(roomId) ?? roomId);
            return (
              <section key={roomId} className="room-group" data-testid={`room-${roomId}`} aria-label={label}>
                <header className="room-heading"><h3>{label}</h3><span>{items.length}</span></header>
                <ul className="device-list">
                  {items.map((device) => {
                    const state = stateById[device.canonical_id];
                    const on = observedOn(state);
                    const control = controlById[device.canonical_id] ?? { kind: 'idle' as const };
                    const lightControl = device.load_type === 'light' && device.control_enabled === true;
                    return (
                      <li key={device.canonical_id} className="device-item" data-enabled={lightControl}>
                        <div className="device-card-main">
                          <button type="button" className="device-button" onClick={() => openDevice(device.canonical_id)} aria-expanded={openId === device.canonical_id} data-testid={`device-${device.canonical_id}`}>
                            <span className="device-name">{device.friendly_name}</span>
                            <span className="device-meta"><span className="device-type">{device.load_type}</span><span className={lightControl ? 'device-access' : 'device-access muted'}>{lightControl ? 'Ready' : 'Read only'}</span></span>
                          </button>
                          <button
                            type="button"
                            className={favorites.has(device.canonical_id) ? 'favorite-button saved' : 'favorite-button'}
                            aria-label={`${favorites.has(device.canonical_id) ? 'Remove' : 'Add'} ${device.friendly_name} ${favorites.has(device.canonical_id) ? 'from' : 'to'} favorites`}
                            aria-pressed={favorites.has(device.canonical_id)}
                            onClick={() => toggleFavorite(device.canonical_id)}
                          >{favorites.has(device.canonical_id) ? '★' : '☆'}</button>
                          {lightControl && (
                            <div className="device-control">
                              <span className={`device-state-label ${on === null ? 'unknown' : on ? 'is-on' : 'is-off'}`} aria-live="polite">
                                <span className="state-dot" aria-hidden="true" />{observedLabel(state)}
                              </span>
                              <button
                                type="button"
                                className={`toggle-button ${on ? 'on' : 'off'}`}
                                aria-label={`${on ? 'Turn off' : 'Turn on'} ${device.friendly_name}`}
                                data-testid={`control-${device.canonical_id}`}
                                disabled={on === null || control.kind === 'sending'}
                                onClick={() => { if (on !== null) void controlDevice(device.canonical_id, !on); }}
                              >
                                {control.kind === 'sending' ? 'Sending…' : on ? 'Turn off' : 'Turn on'}
                              </button>
                            </div>
                          )}
                        </div>
                        {control.kind === 'result' && <p className={`device-result ${control.aggregate}`} role="status" data-testid={`control-result-${device.canonical_id}`}>{control.message}</p>}
                        {control.kind === 'error' && <p className="device-result failed" role="alert">Control failed: {control.message}</p>}
                        {state?.kind === 'error' && lightControl && <p className="device-result failed" role="alert">Could not read current state: {state.message}</p>}
                        {openId === device.canonical_id && (
                          <DeviceStatePanel state={state ?? { kind: 'idle' }} onClose={() => setOpenId(null)} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DeviceStatePanel({ state, onClose }: { readonly state: LoadState<DeviceState>; readonly onClose: () => void }): React.ReactElement {
  return (
    <div className="device-state" data-testid="device-state">
      {state.kind === 'loading' && <p className="muted">Refreshing state…</p>}
      {state.kind === 'error' && <p className="error">Could not read state: {state.message}</p>}
      {state.kind === 'ok' && <pre data-testid="device-state-json">{JSON.stringify(state.data.state, null, 2)}</pre>}
      <button type="button" className="secondary-button" onClick={onClose}>Close details</button>
    </div>
  );
}
