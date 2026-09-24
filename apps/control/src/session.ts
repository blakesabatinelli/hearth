/**
 * Session + CSRF.
 *
 * In-memory store keyed by session_id. The cookie value is a base64url
 * payload of `{session_id, hmac}` so it's tamper-evident even without a
 * backing database.
 *
 * CSRF tokens are per-session opaque random strings. The CSRF header is
 * `x-hearth-csrf` and must match the session's csrf_token. State-changing
 * routes (POST/PUT/PATCH/DELETE) require it; safe methods don't.
 *
 * Session secrets: the HMAC key is loaded from HEARTH_SESSION_SECRET. If
 * absent (test mode) a deterministic per-process key is used; the same
 * key is reused so tests can sign cookies themselves if needed.
 */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Actor, ActorRole, IdempotencyKey } from '@hearth/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'hearth_session';
const CSRF_HEADER = 'x-hearth-csrf';
const CSRF_FORM_FIELD = '_csrf';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

export type Session = {
  readonly session_id: string;
  readonly csrf_token: string;
  readonly actor: Actor;
  readonly created_at: string;
  readonly expires_at: string;
};

export type SessionStoreOptions = {
  readonly secret?: string;
  readonly now?: () => Date;
};

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly secret: string;
  private readonly now: () => Date;

  public constructor(opts: SessionStoreOptions = {}) {
    this.secret = opts.secret ?? randomBytes(32).toString('hex');
    this.now = opts.now ?? (() => new Date());
  }

  public create(actor: Actor): Session {
    const session_id = randomBytes(24).toString('hex');
    const csrf_token = randomBytes(24).toString('hex');
    const now = this.now();
    const session: Session = {
      session_id,
      csrf_token,
      actor,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + COOKIE_MAX_AGE_S * 1000).toISOString(),
    };
    this.sessions.set(session_id, session);
    return session;
  }

  public get(session_id: string): Session | null {
    const s = this.sessions.get(session_id);
    if (!s) return null;
    if (new Date(s.expires_at).getTime() <= this.now().getTime()) {
      this.sessions.delete(session_id);
      return null;
    }
    return s;
  }

  public destroy(session_id: string): void {
    this.sessions.delete(session_id);
  }

  public signCookie(session_id: string): string {
    const mac = createHmac('sha256', this.secret).update(session_id).digest();
    const payload = `${session_id}.${mac.toString('base64url')}`;
    return Buffer.from(payload).toString('base64url');
  }

  public verifyCookie(cookie_value: string): string | null {
    let decoded: string;
    try {
      decoded = Buffer.from(cookie_value, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const dot = decoded.lastIndexOf('.');
    if (dot <= 0) return null;
    const session_id = decoded.slice(0, dot);
    const mac_b64 = decoded.slice(dot + 1);
    const expected = createHmac('sha256', this.secret).update(session_id).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(mac_b64, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;
    return session_id;
  }
}

export const COOKIE = {
  name: COOKIE_NAME,
  csrfHeader: CSRF_HEADER,
  csrfFormField: CSRF_FORM_FIELD,
} as const;

/**
 * Decorator-style helper: read the session cookie + CSRF token from a
 * Fastify request, return the actor (or null).
 */
export function readSession(
  req: FastifyRequest,
  store: SessionStore,
): Session | null {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const session_id = store.verifyCookie(raw);
  if (!session_id) return null;
  return store.get(session_id);
}

/**
 * CSRF guard. Reads either the header or the form field. Returns true if
 * the request is safe (GET/HEAD/OPTIONS) OR the token matches the session.
 */
export function csrfValid(
  req: FastifyRequest,
  session: Session | null,
): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (!session) return false;
  const header_token = req.headers[CSRF_HEADER];
  const header_value = Array.isArray(header_token) ? header_token[0] : header_token;
  if (header_value && header_value === session.csrf_token) return true;
  // Body field fallback for HTML form posts.
  const body = req.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === 'object' && CSRF_FORM_FIELD in body) {
    const v = (body as Record<string, unknown>)[CSRF_FORM_FIELD];
    if (typeof v === 'string' && v === session.csrf_token) return true;
  }
  return false;
}

export function setSessionCookie(reply: FastifyReply, signed: string): void {
  reply.setCookie(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // local / unencrypted deployment for now; production config flips this
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Default actor identity for the no-auth dev mode. Plan section 8 says
 * auth is required; this is the placeholder until `@hearth/auth` lands
 * (which will replace this with a real session store backed by either
 * a local passcode or a reverse-proxy).
 */
export const DEV_DEFAULT_ACTOR: Actor = {
  actor_id: 'dev-default',
  role: 'admin',
  session_id: 'dev-session',
};

export function actorForRole(role: ActorRole, session_id: string): Actor {
  return {
    actor_id: `${role}-${session_id}`,
    role,
    session_id,
  };
}

// Helper exported for tests
export type { IdempotencyKey };