# Hearth v3.0.10

Lands seven of the ten items in `docs/macos-host-setup.md` section 13
"Required implementation before live Hearth use." Closes the gap
between fixture-mode end-to-end proof (v3.0.5 -> v3.0.9) and live
deployment on the operator's Mac.

## What changed

### Items landed (plan section 13)

1. **Real HA adapter (item 1).** New `packages/ha-adapter/src/live.ts`
   implements the `HomeAssistantAdapter` contract against a real
   Home Assistant REST API. Imports `/api/`, `/api/states`,
   `/api/areas`, `/api/registry`, `POST /api/services/<domain>/<service>`.
   Maps HA domains to Hearth `LoadType` (light, fan, switch-as-
   unknown-switch, cover-as-blind, climate-as-other, lock, media_player).
   Filters sensors and binary_sensors out of `listDevices()` because
   they have no commands. `HAConnectionPool` accepts an `(seed, 'ha',
   adapter)` overload so `main.ts` can swap in the live adapter;
   `ProviderKey` widened from `'fake'` to `'fake' | 'ha'`. WebSocket
   `subscribe()` is scaffolded; the polling fallback in `listDevices`
   keeps live behavior correct when WS isn't reachable.

2. **Env-driven control service (item 2).** `apps/control/src/main.ts`
   reads `HEARTH_FIXTURE_MODE` (default `'1'`, safe),
   `HEARTH_HA_URL`, and `HEARTH_HA_TOKEN`. Live mode is fail-closed:
   it requires both env vars and a working `probe()` of `HEARTH_HA_URL`
   before binding. The deprecated "everybody gets the fake adapter"
   behavior is gone.

3. **`HEARTH_EXTRACT_URL` plumbed (item 3).** `main.ts` reads the
   variable and threads it through `wireControl()` via conditional
   spread so the interpreter's GLiNER2 provider runs against the
   real sidecar when set.

4. **OpenClaw adapter (item 5).** New `packages/openclaw-adapter/`
   package. `OpenClawBonsaiProvider` is an HTTP client for the
   OpenClaw external Gateway that runs locally and never sees
   household credentials or any actuation tools. Hard constraints:
   `assertLoopbackOnly()` refuses any URL that doesn't resolve to
   `127.0.0.1`, `localhost`, or `::1`; bearer auth is required; the
   adapter's `validateProposal()` is server-side strict validation
   that throws `ProposalValidationError` on the first failure (never
   silent repair); one retry max on transient 5xx; pin enforcement
   rejects responses that don't report `openclaw_pin=2026.9.6`.

5. **`BonsaiProvider` through that adapter (item 6).** Same class
   implements `BonsaiProvider.propose()` and `validateProposal()`.
   Strict JSON-Schema (`PROPOSAL_JSON_SCHEMA`, version `0.0.1`) is
   sent to the model. Invalid output -> `ProposalValidationError`,
   the interpreter falls back to clarification. `main.ts` wires this
   via `resolveBonsaiProvider()`; if `HEARTH_OPENCLAW_URL` and
   `HEARTH_GATEWAY_TOKEN` are unset, the bonsai slot stays null and
   the interpreter routes through grammar + GLiNER2 only.

6. **Lock structure for OpenClaw (item 7, partial).** New
   `packages/openclaw-adapter/src/lock.ts` exports a TS-typed
   `OpenClawLock`. `pinned_version` mirrors
   `HEARTH_OPENCLAW_PIN` from `@hearth/contracts` (drift-proof).
   `commit_sha`, `llama_cpp_commit_sha`, and the `metal_build_profile`
   are operator-fillable; the `measurements` block carries either
   `'measured'` (with `operator_provenance`) or `'unverified'` with
   `todo_commands` describing what the operator must run. Release-time
   verification (`HEARTH_RELEASE=1`) blocks the build without real
   SHAs. `scripts/verify-openclaw-lock.mjs` enforces this.

7. **Doctor checks for live resources (item 8).** `doctor()` adds
   two checks: `ha-reachable` (live-mode `/api/` probe with bearer
   token) and `openclaw-reachable` (loopback guard + token guard +
   `/agent/turn` probe). Both fail closed if the live resource is
   unreachable in live mode. The Doctor CLI now reports a third
   dimension to its summary: 6 pass in fully-live mode, 5 pass in
   fixture mode.

8. **Stage 0 round-trip (item 9).** New
   `apps/control/tests/round-trip.test.ts` exercises the full chain
   against an in-process HTTP server pretending to be OpenClaw.
   The tests verify that `propose() -> validateProposal() ->
   IntentProposal` round-trips correctly with the happy path, the
   one-5xx retry, and the no-silent-repair-on-invalid path. Item 9
   is now exercised end-to-end.

### Items still owed

- **Item 7 (Bonsai lock, complete the SHAs).** The Bonsai lock
  currently carries TBD placeholders. The operator must run
  `shasum -a 256 "$HEARTH_MODEL_DIR/Bonsai-27B-Q1_0.gguf"` on the
  deployment Mac and patch `models/bonsai.lock.json` and
  `packages/openclaw-adapter/src/lock.ts`. Release builds without
  real SHAs (under `HEARTH_RELEASE=1`) will fail at
  `verify-bonsai-lock.mjs`.

- **Item 10 (Stage 3 evaluation, 200+ reviewed cases).** A repo-
  injectable 200-case JSONL corpus plus a runtime harness that
  drives the `Interpreter.interpret()` path against a known-good
  registry. This is operator-content + corpus work, not build
  work. The package scaffolding was started and discarded when the
  grammar registry shape didn't fit cleanly; this is deferred until
  representative samples exist on the operator side. Until then,
  the operator should NOT claim "live" status from fixture-mode
  test pass counts.

## Verifier

`scripts/verify-openclaw-lock.mjs` is a new verifier, sibling to
`verify-bonsai-lock.mjs` and `verify-gliner2-lock.mjs`. It enforces:

- The lock exports `pinned_version` mirroring `HEARTH_OPENCLAW_PIN`
  (drift-proof).
- `commit_source` is pinned to the upstream GitHub repo (no
  accidental relocations).
- `metal_build_profile.platform` is set (`darwin` or `linux`).
- `measurements` block is present.
- No floating `"latest"` references in the lock.
- `HEARTH_RELEASE=1` requires real SHAs (no
  `PENDING_OPERATOR_VERIFICATION`) and `measurements.status === 'measured'`.

## Verification

```
$ pnpm -r test
contracts      Tests  7 passed (7)
web            Tests  23 passed (23)
extractor      Tests  8 passed (8)
ha-adapter     Tests  24 passed (24)
openclaw-adapter  Tests  26 passed (26)
executor       Tests  31 passed (31)
registry       Tests  12 passed (12)
interpreter    Tests  44 passed (44)
scheduler      Tests  14 passed (14)
apps/control   Tests  51 passed (51)
                          Total: 240 passed (240)
```

```
$ node scripts/verify-portability.mjs && \
  node scripts/verify-gliner2-lock.mjs && \
  node scripts/verify-bonsai-lock.mjs && \
  node scripts/verify-openclaw-lock.mjs
verify-portability: OK
verify-gliner2-lock: OK
verify-bonsai-lock: OK
verify-openclaw-lock: OK
```

## Known carve-out

The release does NOT claim "live deployment ready." Live validation
requires the operator to:

1. Run `shasum -a 256` on the local Bonsai GGUF and patch the lock.
2. Start OpenClaw's external Gateway on `127.0.0.1`.
3. Run `node apps/control/dist/src/main.js doctor` with
   `HEARTH_FIXTURE_MODE=0`, `HEARTH_HA_URL`, `HEARTH_HA_TOKEN`,
   `HEARTH_OPENCLAW_URL`, `HEARTH_GATEWAY_TOKEN` all set.
4. Confirm `[OK] ha-reachable` and `[OK] openclaw-reachable`.

When the operator reports those steps are done and the doctor
shows the live-resource checks PASS, a v3.0.11 release notes file
will record the live-resource validation evidence. Until then
this release marks the **code-complete** state but does not claim
**runtime-proven** state on real devices.
