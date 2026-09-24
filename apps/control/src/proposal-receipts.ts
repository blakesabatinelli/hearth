/**
 * Proposal receipts.
 *
 * A proposal receipt is a small HMAC-signed token that proves
 * /v1/interpret produced a given proposal. /v1/contracts requires the
 * receipt before it will accept a proposal, so clients cannot submit
 * hand-built proposals bypassing the interpreter.
 *
 * Receipts are short-lived (5 minutes by default) and reusable only for
 * the same proposal+request_id pair. The HMAC is over a canonical
 * JSON serialization of the proposal + request_id.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IntentProposal } from '@hearth/contracts';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export type ProposalReceiptInput = {
  proposal: IntentProposal;
  request_id: string;
  ttl_ms?: number;
};

export type ProposalReceipt = {
  /** opaque base64url token; contains sig + payload */
  token: string;
  /** ISO8601 UTC */
  expires_at: string;
  request_id: string;
};

function canonicalize(value: unknown): string {
  // Stable JSON serialization (sorted keys, no extra whitespace).
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function issueReceipt(
  input: ProposalReceiptInput,
  signing_key: string,
  now: Date = new Date(),
): ProposalReceipt {
  const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
  const expires_at = new Date(now.getTime() + ttl).toISOString();
  const payload = canonicalize({
    proposal: input.proposal,
    request_id: input.request_id,
    expires_at,
  });
  const sig = sign(payload, signing_key);
  const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;
  return { token, expires_at, request_id: input.request_id };
}

export type VerifyResult =
  | { readonly ok: true; readonly proposal: IntentProposal; readonly request_id: string }
  | { readonly ok: false; readonly reason: 'no_token' | 'malformed' | 'expired' | 'signature_mismatch' | 'proposal_mismatch' };

export function verifyReceipt(
  receipt_token: string,
  expected_proposal: IntentProposal,
  expected_request_id: string,
  signing_key: string,
  now: Date = new Date(),
): VerifyResult {
  if (!receipt_token) return { ok: false, reason: 'no_token' };
  const parts = receipt_token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [b64, sig] = parts as [string, string];
  let payload: string;
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expected_sig = sign(payload, signing_key);
  // timingSafeEqual requires same-length buffers.
  if (expected_sig.length !== sig.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  let ok = false;
  try {
    ok = timingSafeEqual(Buffer.from(sig), Buffer.from(expected_sig));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: 'signature_mismatch' };

  let parsed: { proposal: IntentProposal; request_id: string; expires_at: string };
  try {
    parsed = JSON.parse(payload) as { proposal: IntentProposal; request_id: string; expires_at: string };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (parsed.request_id !== expected_request_id) return { ok: false, reason: 'proposal_mismatch' };
  if (canonicalize(parsed.proposal) !== canonicalize(expected_proposal)) {
    return { ok: false, reason: 'proposal_mismatch' };
  }
  if (new Date(parsed.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, proposal: parsed.proposal, request_id: parsed.request_id };
}

/**
 * Error thrown when a proposal receipt is missing, expired, or tampered with.
 */
export class UntrustedProposalError extends Error {
  public readonly reason: string;
  public constructor(reason: string) {
    super(`untrusted proposal: ${reason}`);
    this.name = 'UntrustedProposalError';
    this.reason = reason;
  }
}
