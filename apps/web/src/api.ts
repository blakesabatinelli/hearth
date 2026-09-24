/**
 * Tiny API client for the Hearth control surface.
 *
 * Responsibilities:
 *   - Session bootstrap: POST /v1/sessions with role
 *   - Capture the Set-Cookie response header for `hearth_session` and
 *     strip metadata (Path, HttpOnly, SameSite, Max-Age, Expires).
 *   - Persist the raw cookie and csrf_token in sessionStorage so the
 *     page survives an SPA hash-route navigation without re-creating
 *     a session.
 *   - Re-inject `Cookie: hearth_session=...` on every outbound request
 *     (browsers do not expose HttpOnly cookies to JS, and the dev proxy
 *     forwards them too, but being explicit keeps the contract honest).
 *   - Add `x-hearth-csrf: <csrf>` to every state-changing fetch.
 *
 * Out of scope (Stage 4 polish): refresh-on-401, exponential backoff,
 * Service Worker cache, IndexedDB session persistence.
 */

const SESSION_KEY = 'hearth.session_id';
const CSRF_KEY = 'hearth.csrf_token';
const COOKIE_KEY = 'hearth.cookie';

export type SessionInfo = {
  readonly session_id: string;
  readonly csrf_token: string;
  readonly role: string;
  readonly expires_at: string;
};

export type DevicesResponse = {
  readonly devices: ReadonlyArray<{
    readonly canonical_id: string;
    readonly friendly_name: string;
    readonly load_type: string;
    readonly capabilities: ReadonlyArray<string>;
    readonly aliases: ReadonlyArray<string>;
    readonly room_id: string | null;
  }>;
  readonly rooms: ReadonlyArray<{
    readonly room_id: string;
    readonly name: string;
  }>;
  readonly actor: { readonly actor_id: string; readonly role: string };
};

export type DeviceState = {
  readonly state: {
    readonly canonical_id: string;
    readonly observed_at: string;
    readonly source: string;
    readonly values: Readonly<Record<string, unknown>>;
    readonly state_version: number;
  };
};

// Loose: the interpreter's `decision` field is a discriminated union and
// the PWA just renders whatever JSON came back. We type as unknown so the
// UI can pretty-print without lying about field shape.
export type InterpretResponse = {
  readonly request_id: string;
  readonly decision: unknown;
  readonly actor: { readonly actor_id: string; readonly role: string };
};

/**
 * Parse one `Set-Cookie` header value and return ONLY the `name=value`
 * pair (no Path/HttpOnly/SameSite/etc). Multiple cookies in the same
 * header value are tolerated; we filter to `hearth_session`.
 */
export function parseSetCookieForName(
  headerValue: string | null,
  name: string,
): string | null {
  if (!headerValue) return null;
  // Fastify emits one Set-Cookie header per cookie. Some test harnesses
  // join multiple cookies with `, ` which is technically wrong per RFC
  // (Expires contains commas), but for our single-cookie shape this is
  // safe. Split on `,` and walk.
  for (const raw of headerValue.split(/,(?=[^;]+?=)/)) {
    const segment = raw.trim();
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const cookieName = segment.slice(0, eq).trim();
    if (cookieName !== name) continue;
    const valueAndMeta = segment.slice(eq + 1);
    const semi = valueAndMeta.indexOf(';');
    const value = semi === -1 ? valueAndMeta : valueAndMeta.slice(0, semi);
    return `${cookieName}=${value.trim()}`;
  }
  return null;
}

export type HearthApiOptions = {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
};

export class HearthApi {
  private readonly fetchImpl: typeof fetch;
  private cookie: string | null = null;
  private csrf: string | null = null;
  private sessionId: string | null = null;

  public constructor(opts: HearthApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Restore from sessionStorage so a hash navigation doesn't drop session.
    try {
      this.cookie = sessionStorage.getItem(COOKIE_KEY);
      this.csrf = sessionStorage.getItem(CSRF_KEY);
      this.sessionId = sessionStorage.getItem(SESSION_KEY);
    } catch {
      // sessionStorage can throw in private modes / SSR; ignore.
    }
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getCsrf(): string | null {
    return this.csrf;
  }

  public getCookie(): string | null {
    return this.cookie;
  }

  /**
   * POST /v1/sessions. Stores cookie + csrf_token in sessionStorage.
   */
  public async createSession(role: 'admin' | 'member' | 'wall-tablet' = 'admin'): Promise<SessionInfo> {
    const res = await this.fetchImpl('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
      credentials: 'include',
    });
    if (!res.ok) {
      throw new ApiError(`session create failed: ${res.status}`, res.status);
    }
    const body = (await res.json()) as SessionInfo;
    const setCookie = parseSetCookieForName(res.headers.get('set-cookie'), 'hearth_session');
    if (!setCookie) {
      throw new ApiError('session create did not set hearth_session cookie', res.status);
    }
    this.cookie = setCookie;
    this.csrf = body.csrf_token;
    this.sessionId = body.session_id;
    try {
      sessionStorage.setItem(COOKIE_KEY, this.cookie);
      sessionStorage.setItem(CSRF_KEY, this.csrf);
      sessionStorage.setItem(SESSION_KEY, this.sessionId);
    } catch {
      // ignore storage failures
    }
    return body;
  }

  /**
   * Ensure a session exists. Idempotent: returns existing if present,
   * otherwise creates a new admin session.
   */
  public async ensureSession(): Promise<SessionInfo> {
    if (this.sessionId && this.csrf && this.cookie) {
      return {
        session_id: this.sessionId,
        csrf_token: this.csrf,
        role: 'admin',
        expires_at: '',
      };
    }
    return this.createSession('admin');
  }

  public async listDevices(): Promise<DevicesResponse> {
    return this.get<DevicesResponse>('/v1/devices');
  }

  public async getDeviceState(canonical_id: string): Promise<DeviceState> {
    return this.get<DeviceState>(`/v1/devices/${encodeURIComponent(canonical_id)}/state`);
  }

  public async interpret(utterance: string, request_id?: string): Promise<InterpretResponse> {
    const body: Record<string, unknown> = { utterance };
    if (request_id) body.request_id = request_id;
    return this.post<InterpretResponse>('/v1/interpret', body);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.rawFetch(path, { method: 'GET' });
    await this.assertOk(res);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.rawFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await this.assertOk(res);
    return (await res.json()) as T;
  }

  /**
   * Internal raw fetch with cookie + CSRF headers attached. State-changing
   * methods require a CSRF token; GETs do not.
   */
  public async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (init.method && init.method.toUpperCase() !== 'GET' && this.csrf) {
      headers.set('x-hearth-csrf', this.csrf);
    }
    return this.fetchImpl(path, {
      ...init,
      headers,
      credentials: 'include',
    });
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      detail = j.error?.message ?? j.error?.code ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new ApiError(`request failed: ${res.status}${detail ? ` (${detail})` : ''}`, res.status);
  }
}

export class ApiError extends Error {
  public readonly status: number;
  public constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Singleton for the app shell; tests construct their own.
let singleton: HearthApi | null = null;
export function getApi(): HearthApi {
  if (!singleton) singleton = new HearthApi();
  return singleton;
}
