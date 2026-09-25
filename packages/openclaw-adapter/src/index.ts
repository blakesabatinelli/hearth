/**
 * @hearth/openclaw-adapter
 *
 * Adapter from Hearth's interpreter to the OpenClaw external Gateway
 * hosting Bonsai 27B 1-bit.
 *
 * Architecture (plan section 13, items 5+6):
 *
 *   interpreter -> OpenClawBonsaiProvider.propose()
 *                   -> POST http://gateway/agent/turn?tool=bonsai_thinking
 *                   -> Gateway calls Bonsai 27B 1-bit via llama-server (Metal)
 *                   -> Gateway returns JSON (validated against schema)
 *                   -> validateProposal() in this package
 *                   -> IntentProposal -> interpreter -> registry
 *
 * Hearth is the AUTHORITY on identity, permissions, target scope,
 * evidence. Bonsai may only PROPOSE an interpretation. Hearth decides
 * which (if any) interpretation becomes a contract.
 *
 * Constraints enforced by this adapter:
 *
 *   1. No actuation tools. The OpenClaw Gateway is configured with
 *      only `bonsai_thinking` available. No HTTP fetcher, no shell, no
 *      browser, no registry, no household credentials. See
 *      docs/macos-host-setup.md section 7 + docs/decisions/ the
 *      openclaw-scope ADR (added by this change set).
 *   2. Loopback-only. The Gateway URL must resolve to 127.0.0.1.
 *      Anything else is rejected at construction time.
 *   3. Token-authenticated. HEARTH_GATEWAY_TOKEN (loaded by main.ts from
 *      $HEARTH_SECRET_DIR/openclaw-gateway-token) is sent as a bearer
 *      on every request. The token never logs.
 *   4. Strict JSON schema. The adapter feeds Bonsai a JSON Schema and
 *      asks for JSON. The reply is validated against the schema server-
 *      side. Invalid -> clarify/fail, NEVER silent repair.
 *   5. One retry max on transient network failure. No retry on
 *      validation failure (that's a Bonsai/confusion error, not
 *      transient).
 *   6. Pinned version. OPENCLAW_PIN ('2026.9.6') is enforced in the
 *      adapter options and the lock file. Pin committed to
 *      models/openclaw.lock.json (item 7).
 *
 * Stage 0 round-trip (item 9): a smoke test feeds a fixed utterance
 * and asserts the response round-trips validateProposal. The unit
 * tests in tests/openclaw.test.ts use a fake gateway.
 */

export {
  OpenClawBonsaiProvider,
  OpenClawPermanentError,
  OpenClawPinError,
  OpenClawTransientError,
  type OpenClawBonsaiProviderOptions,
  type OpenClawTurnResponse,
  type ProposalStrictSchema,
} from './provider.js';

// Internal exports for tests + downstream consumers that want to
// compose or extend the provider without reaching into private members.
export {
  PROPOSAL_JSON_SCHEMA,
  PROPOSAL_SCHEMA_VERSION,
  ProposalValidationError,
  assertLoopbackOnly,
  buildSystemPrompt,
  buildUserPrompt,
  validateProposalRaw,
} from './protocol.js';
export { openclaw_lock, type OpenClawLock } from './lock.js';
