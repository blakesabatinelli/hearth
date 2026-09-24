# Hearth v3.0.1

QA-regression fixes against v3.0. All test totals are fixture-mode (no live
HA, Bonsai, GLiNER2, or OpenClaw).

## Highlights

- **Session auth gate.** Production-mode `POST /v1/sessions` requires
  `x-hearth-dev-token` and `role=admin` requires `x-hearth-admin-grant`.
  Dev mode (without `HEARTH_REQUIRE_DEV_TOKEN`) keeps the convenient path
  for bring-up.
- **Proposal receipts.** `/v1/contracts` now requires a HMAC-signed
  `proposal_receipt` issued by `/v1/interpret`. Clients can't submit
  hand-built proposals bypassing the interpreter. Dev mode bypasses
  for tests/CI.
- **State-version from observation.** `contract-builder` snapshots
  the live `adapter.getState()` so each contract target carries the
  real `state_version`. Sequential commands now see the version advance;
  the executor's stale-context check fires correctly.
- **Scheduler started.** `apps/control` wires the `Scheduler` with the
  live adapter's state-lookup. `enabled=false` short-circuits. Cron with
  no future match is a no-op.
- **Hold restoration.** `buildContractForHold` now flows
  `target_canonical_id` through `target_phrases`; restore contracts have
  a real target instead of zero.
- **Relative brightness.** `resolveRelativeDesiredValues` converts
  `relative_brightness:+10` into an absolute `brightness` against the
  observed state.
- **PWA production routing.** `apps/web/README.md` documents the
  same-origin deployment story (Caddy/nginx/co-located) and warns that
  the Vite dev proxy is dev-only.
- **Ops scripts.** `start`, `doctor`, `lint`, `upgrade`, `integration`
  scripts added; `scripts/upgrade.mjs` ties them together.

## Tests

197 tests across 9 packages + apps; typecheck clean; portability /
Bonsai-lock / GLiNER2-lock verifiers green; gitleaks clean.

```
packages/contracts:       7/7
packages/registry:      12/12
packages/ha-adapter:    15/15
packages/executor:      31/31
packages/interpreter:   44/44
packages/extractor:      8/8
packages/scheduler:     14/14
apps/control:           43/43
apps/web:               23/23
                      ------
                      197
```

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
GLiNER2 `fastino/gliner2.5-base-v1`, Home Assistant credentials, and a
labeled evaluation corpus. A production-ready declaration is gated on a
live-resource end-to-end run; this release is fixture-mode only.

## Documentation status

This tag predates the `agent | docs | scrub personal references` commit
on `main` (`84e246f`). All publication-facing docs on `main` are now
clean of personal references; clone URLs use the `<owner>/hearth`
placeholder. The release artifact itself is unchanged otherwise.

## Upgrade from v3.0

```bash
git fetch origin --tags
git checkout v3.0.1
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './apps/*' build
docker compose --profile with-extract up -d
node apps/control/dist/src/main.js doctor
```

If you were running v3.0 on the deployment host, run
`scripts/upgrade.mjs` instead. To roll back, `scripts/rollback.sh`
restores `hearth:previous`.
