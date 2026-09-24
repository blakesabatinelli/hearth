import React from 'react';
import type { HearthApi, DevicesResponse, DeviceState } from '../api';

type LoadState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Home screen.
 *
 * Lists devices + rooms from GET /v1/devices. Clicking a device shows its
 * current state from GET /v1/devices/:id/state. Devices are grouped by
 * room (room name shown in the section header; devices without a room
 * appear under "Unassigned").
 */
export function Home({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [list, setList] = React.useState<LoadState<DevicesResponse>>({ kind: 'idle' });
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [stateById, setStateById] = React.useState<Record<string, LoadState<DeviceState>>>({});

  React.useEffect(() => {
    setList({ kind: 'loading' });
    api
      .listDevices()
      .then((data) => setList({ kind: 'ok', data }))
      .catch((err: Error) => setList({ kind: 'error', message: err.message }));
  }, [api]);

  const openDevice = (id: string): void => {
    setOpenId(id);
    if (stateById[id]?.kind === 'ok') return;
    setStateById((prev) => ({ ...prev, [id]: { kind: 'loading' } }));
    api
      .getDeviceState(id)
      .then((data) => setStateById((prev) => ({ ...prev, [id]: { kind: 'ok', data } })))
      .catch((err: Error) =>
        setStateById((prev) => ({ ...prev, [id]: { kind: 'error', message: err.message } })),
      );
  };

  if (list.kind === 'loading' || list.kind === 'idle') {
    return <p className="muted">loading devices...</p>;
  }
  if (list.kind === 'error') {
    return (
      <div className="error" role="alert">
        failed to load devices: {list.message}
      </div>
    );
  }

  const { devices, rooms } = list.data;
  const roomById = new Map(rooms.map((r) => [r.room_id, r.name]));

  // Group devices by room. Order: rooms in their declared order, then "Unassigned".
  type Device = (typeof devices)[number];
  const grouped = new Map<string, Device[]>();
  for (const r of rooms) grouped.set(r.room_id, []);
  grouped.set('__unassigned__', []);
  for (const d of devices) {
    const key = d.room_id && grouped.has(d.room_id) ? d.room_id : '__unassigned__';
    const bucket = grouped.get(key);
    if (bucket) grouped.set(key, [...bucket, d]);
  }

  return (
    <section aria-label="devices">
      <h2>Devices</h2>
      {Array.from(grouped.entries()).map(([roomId, items]) => {
        if (items.length === 0) return null;
        const label = roomId === '__unassigned__' ? 'Unassigned' : (roomById.get(roomId) ?? roomId);
        return (
          <div key={roomId} className="room-group" data-testid={`room-${roomId}`}>
            <h3>{label}</h3>
            <ul className="device-list">
              {items.map((d) => (
                <li key={d.canonical_id} className="device-item">
                  <button
                    type="button"
                    className="device-button"
                    onClick={() => openDevice(d.canonical_id)}
                    aria-expanded={openId === d.canonical_id}
                    data-testid={`device-${d.canonical_id}`}
                  >
                    <span className="device-name">{d.friendly_name}</span>
                    <span className="device-type">{d.load_type}</span>
                  </button>
                  {openId === d.canonical_id && (
                    <DeviceStatePanel
                      state={stateById[d.canonical_id] ?? { kind: 'idle' }}
                      onClose={() => setOpenId(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function DeviceStatePanel({
  state,
  onClose,
}: {
  readonly state: LoadState<DeviceState>;
  readonly onClose: () => void;
}): React.ReactElement {
  return (
    <div className="device-state" data-testid="device-state">
      {state.kind === 'loading' && <p className="muted">loading state...</p>}
      {state.kind === 'error' && (
        <p className="error">failed to load state: {state.message}</p>
      )}
      {state.kind === 'ok' && (
        <pre data-testid="device-state-json">
          {JSON.stringify(state.data.state, null, 2)}
        </pre>
      )}
      <button type="button" onClick={onClose}>close</button>
    </div>
  );
}
