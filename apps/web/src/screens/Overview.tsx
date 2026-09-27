import React from 'react';
import type { HearthApi, DevicesResponse } from '../api';
import { navigate } from '../router';

type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly devices: DevicesResponse } | { readonly kind: 'error'; readonly message: string };

export function Overview({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });
  React.useEffect(() => {
    let active = true;
    api.listDevices().then((devices) => { if (active) setState({ kind: 'ready', devices }); })
      .catch((error: Error) => { if (active) setState({ kind: 'error', message: error.message }); });
    return () => { active = false; };
  }, [api]);

  const ready = state.kind === 'ready' ? state.devices.devices.filter((device) => device.control_enabled).length : null;
  const discovered = state.kind === 'ready' ? state.devices.devices.length : null;
  const review = ready === null || discovered === null ? null : discovered - ready;

  return (
    <section aria-label="home-overview" className="screen-stack">
      <header className="screen-heading"><div><p className="eyebrow">Your home</p><h2>Welcome home</h2><p className="muted">A clear view of what Hearth can control and what still needs review.</p></div></header>
      {state.kind === 'loading' && <p className="muted">Checking Home Assistant…</p>}
      {state.kind === 'error' && <p className="error" role="alert">Home Assistant status unavailable: {state.message}</p>}
      {state.kind === 'ready' && (
        <div className="overview-stats">
          <button type="button" className="overview-card ready-card" onClick={() => navigate('rooms')}><span className="eyebrow">Ready to control</span><strong>{ready}</strong><span>Open room controls</span></button>
          <button type="button" className="overview-card" onClick={() => navigate('devices')}><span className="eyebrow">Discovered</span><strong>{discovered}</strong><span>Browse device inventory</span></button>
          <button type="button" className="overview-card review-card" onClick={() => navigate('attention')}><span className="eyebrow">Read only</span><strong>{review}</strong><span>Review access and identity</span></button>
        </div>
      )}
      <div className="overview-actions" aria-label="Quick actions">
        <button type="button" className="quick-action primary-action" onClick={() => navigate('ask')}><strong>Ask Hearth</strong><span>Describe a lighting request</span></button>
        <button type="button" className="quick-action" onClick={() => navigate('favorites')}><strong>Favorites</strong><span>Open your starred devices</span></button>
        <button type="button" className="quick-action" onClick={() => navigate('routines')}><strong>Routines</strong><span>Review schedules and recent runs</span></button>
        <button type="button" className="quick-action" onClick={() => navigate('history')}><strong>Recent activity</strong><span>See executor receipts</span></button>
      </div>
      {state.kind === 'ready' && <p className="overview-note">Only devices explicitly enabled by Hearth's server-side policy can be operated. Read-only devices remain visible for review.</p>}
    </section>
  );
}
