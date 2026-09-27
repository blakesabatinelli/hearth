import React from 'react';
import { useHashRoute, navigate, type RouteName } from './router';
import { getApi, type HearthApi, type SessionInfo } from './api';
import { Home } from './screens/Home';
import { Ask } from './screens/Ask';
import { History } from './screens/History';
import { Overview } from './screens/Overview';
import { Attention } from './screens/Attention';
import { Devices } from './screens/Devices';
import { Routines } from './screens/Routines';

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
        {session.kind === 'ready' && route === 'home' && <Overview api={api.current} />}
        {session.kind === 'ready' && route === 'rooms' && <Home api={api.current} title="Rooms" />}
        {session.kind === 'ready' && route === 'favorites' && <Home api={api.current} title="Favorites" favoritesOnly />}
        {session.kind === 'ready' && route === 'ask' && <Ask api={api.current} />}
        {session.kind === 'ready' && route === 'routines' && <Routines api={api.current} />}
        {session.kind === 'ready' && route === 'attention' && <Attention api={api.current} />}
        {session.kind === 'ready' && route === 'history' && <History api={api.current} />}
        {session.kind === 'ready' && route === 'devices' && <Devices api={api.current} />}
      </main>
      <footer className="hearth-footer">
        <small>Hearth home control</small>
      </footer>
    </div>
  );
}

function Nav({ route }: { readonly route: RouteName }): React.ReactElement {
  const link = (name: RouteName, label: string): React.ReactElement => (
    <a
      href={name === 'home' ? '#/' : `#/${name}`}
      className={route === name ? 'nav-link active' : 'nav-link'}
      aria-current={route === name ? 'page' : undefined}
      data-testid={`nav-${name}`}
    >
      {label}
    </a>
  );
  return (
    <nav className="hearth-nav" aria-label="primary">
      {link('home', 'Home')}
      {link('rooms', 'Rooms')}
      {link('favorites', 'Favorites')}
      {link('ask', 'Ask')}
      {link('routines', 'Routines')}
      {link('attention', 'Attention')}
      {link('history', 'History')}
      {link('devices', 'Devices')}
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
