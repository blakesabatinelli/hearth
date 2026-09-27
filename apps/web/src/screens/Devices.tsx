import React from 'react';
import type { DevicesResponse, HearthApi } from '../api';

type State = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly data: DevicesResponse } | { readonly kind: 'error'; readonly message: string };

export function Devices({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [filter, setFilter] = React.useState('');
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    api.listDevices().then((data) => { if (active) setState({ kind: 'ready', data }); })
      .catch((error: Error) => { if (active) setState({ kind: 'error', message: error.message }); });
    return () => { active = false; };
  }, [api, refresh]);

  if (state.kind === 'loading') return <section aria-label="devices"><h2>Devices</h2><p className="muted">Loading device inventory…</p></section>;
  if (state.kind === 'error') return <section aria-label="devices"><h2>Devices</h2><p className="error" role="alert">Could not load device inventory: {state.message}</p></section>;

  const roomNames = new Map(state.data.rooms.map((room) => [room.room_id, room.name]));
  const query = filter.trim().toLocaleLowerCase();
  const devices = state.data.devices.filter((device) => !query || `${device.friendly_name} ${device.load_type} ${roomNames.get(device.room_id ?? '') ?? ''} ${device.canonical_id} ${(device.provider_ids ?? []).map((provider) => [provider.entity_id, provider.device_id, provider.platform, provider.device_name, provider.manufacturer, provider.model].join(' ')).join(' ')}`.toLocaleLowerCase().includes(query));
  const readyCount = state.data.devices.filter((device) => device.control_enabled).length;

  return (
    <section aria-label="devices" className="screen-stack">
      <header className="screen-heading">
        <div><p className="eyebrow">Inventory and access</p><h2>Devices</h2><p className="muted">{readyCount} ready to control · {state.data.devices.length} discovered</p></div>
        <button type="button" className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </header>
      <label className="search-field">Search devices<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, room, type, or entity ID" /></label>
      <ul className="inventory-list">
        {devices.map((device) => {
          const provider = device.provider_ids?.find((item) => item.kind === 'ha');
          const room = device.room_id ? roomNames.get(device.room_id) : null;
          return (
            <li className="inventory-card" key={device.canonical_id}>
              <div className="inventory-main"><div><strong>{device.friendly_name}</strong><span className="muted">{room ?? 'Unassigned'} · {device.load_type}</span></div><span className={device.control_enabled ? 'status-pill confirmed' : 'status-pill muted-pill'}>{device.control_enabled ? 'Ready' : 'Read only'}</span></div>
              <div className="capability-list">{device.capabilities.length ? device.capabilities.map((capability) => <span key={capability}>{capability}</span>) : <span>No classified controls</span>}</div>
              <details><summary>Identity and access</summary>
                <dl className="device-facts">
                  <dt>Hearth ID</dt><dd><code>{device.canonical_id}</code></dd>
                  <dt>Home Assistant route</dt><dd><code>{provider?.entity_id ?? 'not available'}</code></dd>
                  <dt>Physical HA device</dt><dd><code>{provider?.device_id ?? 'not assigned'}</code></dd>
                  <dt>Integration</dt><dd>{provider?.platform ?? 'not available'}</dd>
                  <dt>Device make and model</dt><dd>{[provider?.manufacturer, provider?.model].filter(Boolean).join(' ') || 'not available'}</dd>
                  <dt>Entity category</dt><dd>{provider?.entity_category ?? 'primary entity'}</dd>
                  <dt>Allowed roles</dt><dd>{device.allowed_actors?.join(', ') || 'none'}</dd>
                  <dt>Policy</dt><dd>{device.control_enabled ? 'Enabled by the server allowlist' : 'Discovery only until identity, load, route, and feedback are reviewed'}</dd>
                </dl>
              </details>
            </li>
          );
        })}
      </ul>
      {devices.length === 0 && <p className="empty-state">No devices match this search.</p>}
    </section>
  );
}
