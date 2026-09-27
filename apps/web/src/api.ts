/**
 * Tiny API client for the Hearth control surface.
 *
 * Responsibilities:
 *   - Session bootstrap: POST /v1/sessions with role
 *   - Let the browser store and send the HttpOnly session cookie.
 *   - Persist the session ID, role, and CSRF token in sessionStorage so
 *     the page survives SPA hash-route navigation without re-creating a
 *     session. The cookie itself never enters JavaScript.
 *   - Add `x-hearth-csrf: <csrf>` to every state-changing fetch.
 *   - Renew an expired admin session once after a 401, then retry that call.
 *
 * Out of scope: exponential backoff, Service Worker cache, IndexedDB
 * session persistence.
 */

const SESSION_KEY = 'hearth.session_id';
const ROLE_KEY = 'hearth.role';
const CSRF_KEY = 'hearth.csrf_token';
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
    readonly control_enabled?: boolean;
    readonly provider_ids?: ReadonlyArray<{
      readonly kind: string;
      readonly entity_id?: string;
      readonly device_id?: string;
      readonly platform?: string;
      readonly unique_id?: string;
      readonly entity_category?: string | null;
      readonly device_name?: string | null;
      readonly manufacturer?: string | null;
      readonly model?: string | null;
    }>;
    readonly allowed_actors?: ReadonlyArray<string>;
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

export type ContractExecutionResponse = {
  readonly contract_id: string;
  readonly receipt: unknown;
};

export type ReceiptRecord = {
  readonly receipt_id: string;
  readonly contract_id: string;
  readonly actor: { readonly actor_id: string; readonly role: string };
  readonly aggregate: string;
  readonly created_at: string;
  readonly per_target: Readonly<Record<string, { readonly kind: string; readonly observed_at?: string; readonly error?: unknown }>>;
};

export type RoutineRecord = {
  readonly routine_id: string;
  readonly name: string;
  readonly cron: string;
  readonly time_zone?: string;
  readonly intent_family: string;
  readonly target_phrases: ReadonlyArray<string>;
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly exclusions: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly recent_fires: ReadonlyArray<{ readonly fired_at: string; readonly status: string; readonly error: string | null }>;
};

export type DirectControlResponse = ContractExecutionResponse;

export type HearthApiOptions = {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
};

export class HearthApi {
  private readonly fetchImpl: typeof fetch;
  private csrf: string | null = null;
  private sessionId: string | null = null;
  private role: string | null = null;
  private sessionValidated = false;
  private sessionRenewal: Promise<void> | null = null;
  private sessionGeneration = 0;

  public constructor(opts: HearthApiOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Restore from sessionStorage so a hash navigation doesn't drop session.
    try {
      this.csrf = sessionStorage.getItem(CSRF_KEY);
      this.sessionId = sessionStorage.getItem(SESSION_KEY);
      this.role = sessionStorage.getItem(ROLE_KEY);
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

  /**
   * POST /v1/sessions. The browser stores the HttpOnly cookie from the response.
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
    this.csrf = body.csrf_token;
    this.sessionId = body.session_id;
    this.role = body.role;
    this.sessionValidated = true;
    this.sessionGeneration += 1;
    try {
      sessionStorage.setItem(CSRF_KEY, this.csrf);
      sessionStorage.setItem(SESSION_KEY, this.sessionId);
      sessionStorage.setItem(ROLE_KEY, this.role);
    } catch {
      // ignore storage failures
    }
    return body;
  }

  /**
   * Ensure a session exists. Idempotent: returns existing if present,
   * otherwise creates a new admin session for this local PWA.
   */
  public async ensureSession(): Promise<SessionInfo> {
    if (this.sessionId && this.csrf && this.role === 'admin') {
      if (!this.sessionValidated) {
        const res = await this.fetchImpl('/v1/csrf', { method: 'GET', credentials: 'include' });
        if (res.ok) {
          const body = await res.json() as { csrf_token: string };
          this.csrf = body.csrf_token;
          this.sessionValidated = true;
          try { sessionStorage.setItem(CSRF_KEY, this.csrf); } catch { /* ignore storage failures */ }
        } else if (res.status !== 401) {
          throw new ApiError(`session check failed: ${res.status}`, res.status);
        }
      }
      if (this.sessionValidated) {
        return {
          session_id: this.sessionId,
          csrf_token: this.csrf,
          role: this.role,
          expires_at: '',
        };
      }
    }
    return this.createSession('admin');
  }

  public async listDevices(): Promise<DevicesResponse> {
    return this.get<DevicesResponse>('/v1/devices');
  }

  public async getDeviceState(canonical_id: string): Promise<DeviceState> {
    return this.get<DeviceState>(`/v1/devices/${encodeURIComponent(canonical_id)}/state`);
  }

  public async controlDevice(canonical_id: string, on: boolean): Promise<DirectControlResponse> {
    return this.post<DirectControlResponse>(
      `/v1/devices/${encodeURIComponent(canonical_id)}/control`,
      { desired_values: { on } },
    );
  }

  public async interpret(utterance: string, request_id?: string): Promise<InterpretResponse> {
    const body: Record<string, unknown> = { utterance };
    if (request_id) body.request_id = request_id;
    return this.post<InterpretResponse>('/v1/interpret', body);
  }

  /** Submit a server-issued proposal receipt for executor-backed dispatch. */
  public async executeProposal(
    request_id: string,
    proposal: unknown,
    proposal_receipt: string,
  ): Promise<ContractExecutionResponse> {
    return this.post<ContractExecutionResponse>('/v1/contracts', { request_id, proposal, proposal_receipt });
  }

  public async listReceipts(limit = 50): Promise<ReadonlyArray<ReceiptRecord>> {
    const response = await this.get<{ receipts: ReadonlyArray<ReceiptRecord> }>(`/v1/receipts?limit=${encodeURIComponent(String(limit))}`);
    return response.receipts;
  }

  public async listRoutines(): Promise<ReadonlyArray<RoutineRecord>> {
    const response = await this.get<{ routines: ReadonlyArray<RoutineRecord> }>('/v1/routines');
    return response.routines;
  }

  public async createRoutine(input: {
    readonly name: string;
    readonly time_local: string;
    readonly time_zone: string;
    readonly target_canonical_id: string;
    readonly on: boolean;
  }): Promise<RoutineRecord> {
    const response = await this.post<{ routine: RoutineRecord }>('/v1/routines', input);
    return response.routine;
  }

  public async setRoutineEnabled(routine_id: string, enabled: boolean): Promise<void> {
    await this.patch(`/v1/routines/${encodeURIComponent(routine_id)}`, { enabled });
  }

  public async deleteRoutine(routine_id: string): Promise<void> {
    await this.delete(`/v1/routines/${encodeURIComponent(routine_id)}`);
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

  private async patch(path: string, body: unknown): Promise<void> {
    const res = await this.rawFetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await this.assertOk(res);
  }

  private async delete(path: string): Promise<void> {
    const res = await this.rawFetch(path, { method: 'DELETE' });
    await this.assertOk(res);
  }

  /**
   * Internal raw fetch with cookie + CSRF headers attached. State-changing
   * methods require a CSRF token; GETs do not.
   */
  public async rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const perform = (): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (init.method && init.method.toUpperCase() !== 'GET' && this.csrf) {
        headers.set('x-hearth-csrf', this.csrf);
      }
      return this.fetchImpl(path, { ...init, headers, credentials: 'include' });
    };
    const generation = this.sessionGeneration;
    const first = await perform();
    if (first.status !== 401 || path === '/v1/sessions') return first;
    if (generation === this.sessionGeneration) await this.renewAdminSession();
    return perform();
  }

  private async renewAdminSession(): Promise<void> {
    if (this.sessionRenewal) return this.sessionRenewal;
    this.sessionId = null;
    this.csrf = null;
    this.role = null;
    this.sessionValidated = false;
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(CSRF_KEY);
      sessionStorage.removeItem(ROLE_KEY);
    } catch { /* session storage can be unavailable */ }
    this.sessionRenewal = this.createSession('admin').then(() => undefined).finally(() => { this.sessionRenewal = null; });
    return this.sessionRenewal;
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
