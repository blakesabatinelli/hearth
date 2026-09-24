import React from 'react';

/**
 * History screen.
 *
 * Placeholder: there is no list-receipts endpoint yet. We render an empty
 * panel with a clear "not implemented" notice so the user can see we know
 * it's missing. When /v1/receipts (list) lands, swap this for a real
 * paginated list.
 */
export function History(): React.ReactElement {
  return (
    <section aria-label="history">
      <h2>History</h2>
      <div className="placeholder" data-testid="history-placeholder">
        <p>No receipts to show yet.</p>
        <p className="muted">
          The backend has <code>GET /v1/receipts/:id</code> for a single
          contract, but no list endpoint yet. This panel will populate
          when that endpoint lands.
        </p>
      </div>
    </section>
  );
}
