import React from 'react';
import type { DeviceState, DevicesResponse, HearthApi } from '../api';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: DevicesResponse; readonly liveStates: ReadonlyMap<string, DeviceState | null> }
  | { readonly kind: 'error'; readonly message: string };

export function Attention({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [refresh, setRefresh] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    api.listDevices().then(async (data) => {
      const enabled = data.devices.filter((device) => device.control_enabled);
      const results = await Promise.all(enabled.map(async (device) => {
        try { return [device.canonical_id, await api.getDeviceState(device.canonical_id)] as const; }
        catch { return [device.canonical_id, null] as const; }
      }));
      if (active) setState({ kind: 'ready', data, liveStates: new Map(results) });
    }).catch((error: Error) => { if (active) setState({ kind: 'error', message: error.message }); });
    return () => { active = false; };
  }, [api, refresh]);

  if (state.kind === 'loading') return <section aria-label="attention"><h2>Attention</h2><p className="muted">Checking device coverage…</p></section>;
  if (state.kind === 'error') return <section aria-label="attention"><h2>Attention</h2><p className="error" role="alert">Could not check device coverage: {state.message}</p></section>;

  const { devices } = state.data;
  const roomNames = new Map(state.data.rooms.map((room) => [room.room_id, room.name]));
  const readOnly = devices.filter((device) => !device.control_enabled);
  const unknownLoads = readOnly.filter((device) => device.load_type === 'unknown-switch');
  const duplicateNames = new Map<string, typeof devices>();
  for (const device of devices) {
    const key = device.friendly_name.trim().toLocaleLowerCase();
    duplicateNames.set(key, [...(duplicateNames.get(key) ?? []), device]);
  }
  const duplicateGroups = [...duplicateNames.values()].filter((group) => group.length > 1);
  const unavailableReady = devices.filter((device) => device.control_enabled && state.liveStates.get(device.canonical_id) === null);

  return (
    <section aria-label="attention" className="screen-stack">
      <header className="screen-heading"><div><p className="eyebrow">Review before activation</p><h2>Attention</h2><p className="muted">Items Hearth cannot safely resolve or verify automatically.</p></div><button type="button" className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></header>
      <div className="attention-summary">
        <article><strong>{readOnly.length}</strong><span>read-only devices</span></article>
        <article><strong>{unknownLoads.length}</strong><span>unclassified switches</span></article>
        <article><strong>{duplicateGroups.length}</strong><span>repeated friendly names</span></article>
        <article><strong>{unavailableReady.length}</strong><span>ready devices with unreadable state</span></article>
      </div>
      {unavailableReady.length > 0 && <div className="attention-banner" role="alert"><strong>Control status needs attention.</strong> Fresh state could not be read for {unavailableReady.map((device) => device.friendly_name).join(', ')}. Hearth disables its control until state is available.</div>}
      {duplicateGroups.length > 0 && <section className="attention-section"><h3>Names with more than one route</h3><p className="muted">Matching friendly names can represent duplicate integrations or different physical devices. Verify identity and current state before changing Hearth's allowlist.</p>
        <ul className="inventory-list">{duplicateGroups.map((group) => { const route = group[0]?.provider_ids?.find((provider) => provider.kind === 'ha'); return <li className="inventory-card" key={group[0]!.friendly_name}><strong>{group[0]!.friendly_name}</strong><ul className="route-list">{group.map((device) => { const deviceRoute = device.provider_ids?.find((provider) => provider.kind === 'ha'); return <li key={device.canonical_id}><span>{roomNames.get(device.room_id ?? '') ?? 'Unassigned'} · {device.load_type} · {deviceRoute?.platform ?? 'unknown integration'} · HA device {deviceRoute?.device_id ?? 'not assigned'}</span><code>{deviceRoute?.entity_id ?? device.canonical_id}</code><span className="muted">{[deviceRoute?.manufacturer, deviceRoute?.model].filter(Boolean).join(' ') || 'Make/model not reported'}</span></li>; })}</ul><span className="muted">Compare the HA device IDs to determine whether these routes point to one physical device.</span>{route?.device_name && <span className="muted">Reported device name: {route.device_name}</span>}</li>; })}</ul>
      </section>}
      <section className="attention-section"><h3>Read-only devices</h3><p className="muted">These remain discoverable, but Hearth needs a verified device identity, load type, route, and feedback policy before enabling control.</p>
        {readOnly.length === 0 ? <p className="empty-state">Every discovered device is enabled under the current policy.</p> : <ul className="inventory-list">{readOnly.map((device) => <li className="inventory-card" key={device.canonical_id}><div className="inventory-main"><div><strong>{device.friendly_name}</strong><span className="muted">{roomNames.get(device.room_id ?? '') ?? 'Unassigned'} · {device.load_type}</span></div><span className="status-pill muted-pill">Read only</span></div><p className="muted">{device.load_type === 'unknown-switch' ? 'Identify the connected load and its physical location.' : device.load_type === 'lock' ? 'Locks need a dedicated safety policy and verified lock-state evidence.' : 'Verify this entity is the intended physical device and not a duplicate or group route.'}</p></li>)}</ul>}
      </section>
    </section>
  );
}
