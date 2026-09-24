import React from 'react';
import { useHashRoute, navigate, type RouteName } from './router';
import { getApi, type HearthApi, type SessionInfo } from './api';
import { Home } from './screens/Home';
import { Ask } from './screens/Ask';
import { History } from './screens/History';

type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly info: SessionInfo }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Top-level shell. Boots a session on mount, renders a hash-routed screen.
 *
 * Session bootstrap is fire-and-show: we POST /v1/sessions on first render
 * and show a tiny "connecting" message until the cookie + CSRF are stored.
 * The screens assume a session exists by the time they fetch.
 */
export function App(): React.ReactElement {
  const route = useHashRoute();
  const [session, setSession] = React.useState<SessionState>({ kind: 'loading' });
  const api = React.useRef<HearthApi>(getApi());

  React.useEffect(() => {
    let cancelled = false;
    api.current
      .ensureSession()
      .then((info) => {
        if (!cancelled) setSession({ kind: 'ready', info });
      })
      .catch((err: Error) => {
        if (!cancelled) setSession({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="hearth-shell">
      <header className="hearth-header">
        <h1>Hearth</h1>
        <SessionBadge session={session} />
      </header>
      <Nav route={route} />
      <main className="hearth-main">
        {session.kind === 'loading' && <p className="muted">connecting...</p>}
        {session.kind === 'error' && (
          <div className="error" role="alert">
            <strong>session error:</strong> {session.message}
          </div>
        )}
        {session.kind === 'ready' && route === 'home' && <Home api={api.current} />}
        {session.kind === 'ready' && route === 'ask' && <Ask api={api.current} />}
        {session.kind === 'ready' && route === 'history' && <History />}
      </main>
      <footer className="hearth-footer">
        <small>Hearth PWA - Stage 4 skeleton</small>
      </footer>
    </div>
  );
}

function Nav({ route }: { readonly route: RouteName }): React.ReactElement {
  const link = (name: RouteName, label: string): React.ReactElement => (
    <a
      href={name === 'home' ? '#/' : `#/${name}`}
      className={route === name ? 'nav-link active' : 'nav-link'}
      data-testid={`nav-${name}`}
    >
      {label}
    </a>
  );
  return (
    <nav className="hearth-nav" aria-label="primary">
      {link('home', 'Home')}
      {link('ask', 'Ask')}
      {link('history', 'History')}
    </nav>
  );
}

function SessionBadge({ session }: { readonly session: SessionState }): React.ReactElement {
  if (session.kind === 'loading') return <span className="badge muted">session: ...</span>;
  if (session.kind === 'error') return <span className="badge error">session: error</span>;
  return <span className="badge ok">session: {session.info.role}</span>;
}

// Re-export navigate for tests / callers.
export { navigate };
