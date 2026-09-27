# Hearth state

Last updated: 2026-09-27

## Current stage

Stage 0 passed on the setup host earlier in this project. At the latest
check, live service endpoints respond and Hearth reports 56 discovered
devices. Stage 1 passes its fixture gate. Stage 3 passes the reviewed, frozen
synthetic corpus on grammar, GLiNER2-only, and combined paths. Stages 2 and 4
through 7 remain open.

## Verified on the setup host

- The workspace builds successfully. The full TypeScript workspace test suite
  passes, including the control, interpreter, executor, HA adapter, scheduler,
  and PWA packages.
- The control API uses `better-sqlite3` 13.0.3 with the existing local
  database. Ten no-op contracts and a persisted receipt read completed while
  the service remained healthy.
- OpenClaw 2026.9.6 and the local Bonsai llama.cpp server are running. Bonsai
  uses the configured local model and OpenClaw Gateway.
- GLiNER2 2.0.0 runs in the separate extractor sidecar with the local
  `hearth-pilot-20260925-v5` checkpoint. Its 32 held-out pilot cases reached
  93.75% intent accuracy and 90.625% exact intent plus entities. This pilot
  evaluation is not the Stage 3 gate corpus.
- A separate local v7 LoRA checkpoint was trained on 94 private pilot examples
  and evaluated on 32 held-out examples. It reached 96.875% intent accuracy
  and 90.625% exact intent plus action-relevant entities. Its hold-until
  category reached 75%; scene extraction still needs investigation. It has not
  replaced the running v5 checkpoint pending the Stage 3 evaluation and
  category gating.
- Home Assistant is reachable in live mode. Hearth discovers 56 devices.
  Physical dispatch is allowlisted to exactly the two previously verified
  master-bedroom lamp entities. The current routes are recorded only in the
  owner-only runtime review and allowlist files. Existing Hue and SmartThings
  pairings were not changed.
- The local PWA creates an admin session. The two pilot devices report
  `control_enabled: true`; all other discovered devices remain outside the
  executor allowlist.
- `Turn on the master bedroom lamps` is resolved by grammar rule
  `room-lamps@1` to alpha lamp and beta lamp. When already on, the executor
  returns `no-op` with `already-satisfied` for each target and sends no device
  service call.
- Home Assistant Core 2026.9.3 had recurring SmartThings event-stream
  disconnects (`TransferEncodingError` and SSE read timeouts). Its SmartThings
  config entry still reported `loaded`, while both lamp states stayed stale.
  Reloading that existing HA config entry synchronized the pending off state.
  No pairing or credential changes were made.
- After the HA reload, the original turn-on request ran through Hearth's PWA
  and executor. Both lamps returned `observed-after-command`, Home Assistant
  reported them on, and the lamps were left on. The off command had remained
  unconfirmed at the time Hearth returned its receipt.
- The executor waits for a live poll before treating a command as already
  satisfied. A fresh poll is timestamped when Hearth reads Home Assistant,
  rather than with the older last-change time. After a state-changing command,
  the executor watches for a matching state event and polls for up to five
  seconds before reporting confirmed or sent-unconfirmed.
- The Ask screen reports confirmed, already-satisfied, partial, failed, and
  unconfirmed results in plain language. Receipt details remain available in
  History without exposing session IDs or signed proposal receipts in Ask.
- On 2026-09-27 the production PWA executed `Turn on the master bedroom lamps`
  through grammar, the contract API, and the executor. Both authorized lamps
  were already on; the receipt reported `no-op` with `already-satisfied` for
  both. No device command was dispatched.
- Home Assistant, OpenClaw, GLiNER2, Bonsai, and both PWA listeners respond on
  their expected local endpoints. Hearth `/readyz` reports `ready` and 56
  discovered devices. The latest control and production web processes were
  restarted from the current build.
- The current Hearth doctor run passes all nine checks, including Node,
  SQLite, session secret, GLiNER2, both model lockfiles, live HA, and the
  authenticated OpenClaw Gateway handshake.
- On 2026-09-27, the production gateway returned the built PWA and proxied
  `/healthz` and `/readyz`; readiness reported 56 devices. The PWA's current
  web suite passes 46 tests and its production build succeeds, including the
  rule that a failed tap becomes uncertain and is not retried until state is
  refreshed.
- Rechecked the user's development PWA endpoint on 2026-09-27: admin session
  creation returned HTTP 200, then authenticated device discovery returned
  HTTP 200 with 56 records, two controllable devices, and 54 read-only records.
  The earlier 403 was not reproducible against the current running services.
- Re-ran Stage 1 fixture suites on 2026-09-27: control 74, scheduler 20, and
  executor 36 tests passed. Re-validated the saved Stage 3 reports against the
  frozen corpus hash: grammar, GLiNER2-only, and combined each passed 200 cases
  with 150/150 exact supported cases, zero wrong-target admissions, zero
  unauthorized admissions, zero dropped exclusions, and zero sample failures.
- A macOS LaunchAgent generator now prepares owner-only, secret-free plists for
  Bonsai, GLiNER2, control, and the production PWA. All four pass `plutil -lint`;
  wrapper syntax and generation tests pass. All four LaunchAgents are now
  installed and loaded. The production PWA was gracefully terminated and
  restarted by launchd, then returned HTTP 200.
- The refreshed private HA export writes the current exact allowlist to
  `secrets/hearth-actuation-allowlist` with owner-only permissions, so a
  managed control launch can preserve the approved routes without committing
  device identifiers.
- The control runtime uses a shared SQLite database for executor receipts and
  scheduler state. At startup, pending schedule fires are marked skipped
  because the prior process may already have sent the command; they are not
  replayed blindly.
- Contract creation rejects proposals with unresolved fields, rejects
  unresolved exclusions, and removes excluded canonical devices from the
  target list before dispatch.

## Remaining work

- Stage 1 passes its fixture gate. Control (74), scheduler (20), and executor
  (36) tests pass with both model providers explicitly stubbed unavailable.
  Restart recovery does not replay when state is stale, missing, or incomplete;
  a fresh mismatch permits one idempotent state-setting retry.
- Complete fixture and live discovery review for the supported devices,
  including identity, load type, route, and evidence policy.
- Install Tailscale with local administrator authorization, sign in to the
  household tailnet, set the exact approved identity in the gateway, configure
  tailnet-only Serve, and pair/test the iPad. The Mac is currently locked and
  the package installer cannot request the administrator password in this
  session.
- Grammar, GLiNER2-only, and combined paths pass the reviewed, frozen 200-case
  synthetic corpus: 150/150 exact supported cases, zero wrong-target
  admissions, zero unauthorized admissions, zero dropped exclusions, and no
  sample failures. Combined used GLiNER2 39 times and Bonsai 39 times, with
  19.5% Bonsai fallback invocation, 15,992.2 ms mean end-to-end latency, and
  50,229,312 bytes evaluator-process peak RSS. GLiNER2-only averaged 17.37 ms
  with 47,722,304 bytes evaluator-process peak RSS. The RSS values exclude
  model server memory. Household identity and route verification remain
  required before enabling any additional device.
- Stage 4 requires the broader lighting demo, network-drop behavior, and
  accurate uncertainty reporting.
- Stage 5 requires durable routine, restart, duplicate occurrence, DST,
  stale-registry, and manual-override checks.
- Stages 6 and 7 require clean installation, upgrade, rollback, backup
  restoration, remote retrieval, and checksum verification.
- Complete Bonsai lock metadata for source revision, llama.cpp build profile,
  prompt-template compatibility, and measured peak memory.
- Monitor the SmartThings event stream. Home Assistant's upstream issues
  describe similar event-feed failures that recover after reloading the
  integration; automatic recovery is not configured in Hearth.

## Safety posture

The current control API runs in live Home Assistant mode on loopback with a
local admin session. The executor can dispatch only to the two named
master-bedroom lamp entities above. The Hue room group and all other discovered
devices are outside the allowlist. OpenClaw has no Hearth device-control tools,
and the live scheduler uses SQLite. Hearth, HA, OpenClaw, GLiNER2, Bonsai, and
the PWA are responding locally.
