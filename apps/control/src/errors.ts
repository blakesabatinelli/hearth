/**
 * Maps domain errors from `@hearth/executor` and `@hearth/interpreter` to
 * HTTP status codes + JSON-safe error bodies. The body shape follows the
 * plan's "contract errors are explicit, never opaque" rule.
 */
import {
  IdempotencyConflictError,
  StaleContextError,
  SceneScopeUncertainError,
  ContractExpiredError,
  ContractStatusError,
} from '@hearth/executor';
import { ForbiddenFieldError } from '@hearth/interpreter';

export type ApiErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

export type ApiError = { readonly status: number; readonly body: ApiErrorBody };

export function mapDomainError(err: unknown): ApiError {
  if (err instanceof IdempotencyConflictError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'idempotency_conflict',
          message: err.message,
          details: {
            contract_id: err.contract_id,
            request_id: err.request_id,
          },
        },
      },
    };
  }
  if (err instanceof StaleContextError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'stale_context',
          message: err.message,
          details: {
            canonical_id: err.canonical_id,
            expected_state_version: err.expected_state_version,
            actual_state_version: err.actual_state_version,
          },
        },
      },
    };
  }
  if (err instanceof SceneScopeUncertainError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'scene_scope_uncertain',
          message: err.message,
        },
      },
    };
  }
  if (err instanceof ContractExpiredError) {
    return {
      status: 410,
      body: {
        error: {
          code: 'contract_expired',
          message: err.message,
        },
      },
    };
  }
  if (err instanceof ContractStatusError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'invalid_contract_status',
          message: err.message,
        },
      },
    };
  }
  if (err instanceof ForbiddenFieldError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'forbidden_field',
          message: err.message,
        },
      },
    };
  }
  // Unknown error: 500 with redacted message. The real message goes to
  // server logs (callers wire this in via Fastify's error handler).
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : 'unknown error',
      },
    },
  };
}