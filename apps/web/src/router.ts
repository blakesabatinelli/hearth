/**
 * Tiny hash router.
 *
 * Hash routes look like `#/`, `#/ask`, `#/history`. We listen to
 * `hashchange`. Empty hash (no `#` or just `#`) is treated as `home`.
 *
 * This is intentionally small: no react-router, no path parsing. The
 * Stage 4 PWA has three screens; we don't need nested routes.
 */

import { useEffect, useState } from 'react';

export type RouteName = 'home' | 'ask' | 'history';

const ROUTES: ReadonlyMap<string, RouteName> = new Map<string, RouteName>([
  ['', 'home'],
  ['home', 'home'],
  ['ask', 'ask'],
  ['history', 'history'],
]);

export function parseHash(hash: string): RouteName {
  // Strip leading `#` and any `/` after it. Examples:
  //   ``       -> ''
  //   `#`      -> ''
  //   `#/`     -> ''
  //   `#/home` -> 'home'
  //   `#/ask`  -> 'ask'
  const stripped = hash.replace(/^#\/?/, '').trim();
  const r = ROUTES.get(stripped);
  return r ?? 'home';
}

export function navigate(route: RouteName): void {
  const target = route === 'home' ? '#/' : `#/${route}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export function useHashRoute(): RouteName {
  const [route, setRoute] = useState<RouteName>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
