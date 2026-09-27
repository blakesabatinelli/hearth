import React from 'react';
import type { HearthApi, ReceiptRecord } from '../api';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly receipts: ReadonlyArray<ReceiptRecord>; readonly names: ReadonlyMap<string, string> }
  | { readonly kind: 'error'; readonly message: string };

const aggregateLabels: Record<string, string> = {
  confirmed: 'Confirmed',
  'already-satisfied': 'Already in that state',
  'no-op': 'Already in that state',
  partial: 'Partially completed',
  failed: 'Failed',
  expired: 'Expired before dispatch',
  cancelled: 'Cancelled',
  'sent-unconfirmed': 'Sent, not confirmed',
};

export function History({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [refresh, setRefresh] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    Promise.all([api.listReceipts(50), api.listDevices()])
      .then(([receipts, devices]) => {
        if (!active) return;
        setState({ kind: 'ready', receipts, names: new Map(devices.devices.map((device) => [device.canonical_id, device.friendly_name])) });
      })
      .catch((error: Error) => { if (active) setState({ kind: 'error', message: error.message }); });
    return () => { active = false; };
  }, [api, refresh]);

  if (state.kind === 'loading') return <section aria-label="history"><h2>History</h2><p className="muted">Loading recent activity…</p></section>;
  if (state.kind === 'error') return <section aria-label="history"><h2>History</h2><p className="error" role="alert">Could not load activity: {state.message}</p></section>;

  return (
    <section aria-label="history" className="screen-stack">
      <header className="screen-heading">
        <div><p className="eyebrow">Recent activity</p><h2>History</h2><p className="muted">Executor receipts are the record of what Hearth observed.</p></div>
        <button type="button" className="secondary-button" onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
      </header>
      {state.receipts.length === 0 ? (
        <div className="empty-state"><h3>No commands yet</h3><p>Commands and routine runs will appear here with their executor evidence.</p></div>
      ) : (
        <ol className="history-list">
          {state.receipts.map((receipt) => (
            <li className="history-card" key={receipt.receipt_id}>
              <div className="history-card-heading">
                <div><strong>{aggregateLabels[receipt.aggregate] ?? receipt.aggregate}</strong><span className="muted">{new Date(receipt.created_at).toLocaleString()}</span></div>
                <span className={`status-pill ${receipt.aggregate}`}>{receipt.actor.role}</span>
              </div>
              <ul className="history-targets">
                {Object.entries(receipt.per_target).map(([id, outcome]) => (
                  <li key={id}>
                    <span>{state.names.get(id) ?? id}</span>
                    <span className="muted">{targetLabel(outcome.kind)}</span>
                  </li>
                ))}
              </ul>
              <details><summary>Receipt details</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function targetLabel(kind: string): string {
  switch (kind) {
    case 'already-satisfied': return 'Already satisfied, no device call';
    case 'observed-after-command': return 'Confirmed after command';
    case 'optimistic-only': return 'Sent, awaiting confirmation';
    case 'unknown-after-failure': return 'Uncertain, check device state';
    case 'failed': return 'Failed';
    default: return kind;
  }
}
