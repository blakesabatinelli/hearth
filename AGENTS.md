# AGENTS.md -  Hearth

> How future agents (human or AI) work this repo. Read first, every session.

## What Hearth is

Hearth is Blake's installable home management system: a PWA front end (Rooms, Favorites, Ask, Routines, Attention), an independent TypeScript control service (`hearth-control`), a pinned OpenClaw conversational runtime (`hearth-openclaw`), and a local Bonsai language model (`hearth-bonsai`). Home Assistant is the principal integration layer. SmartThings/Hue pairings are preserved.

The whole plan is in `HEARTH_HERMES_DEVELOPMENT_PLAN.md` (v3.0, 2026-09-24). Read it before changing scope. This file is the working contract; the plan is the spec.

## Hard rules (no exceptions)

1. **No em dashes anywhere.** Use regular `-` or rewrite. Vault rule.
2. **Bonsai is the only model.** No Qwen, no cloud fallback. Model is gated behind the `BonsaiProvider` interface. The `mock-bonsai` adapter stands in until real weights + serving runtime round-trip (user-approved 2026-09-24).
3. **No device actuation outside the executor.** UI, routines, direct controls, model output -  all reach physical devices through the executor's contract path. Opaque scripts and scenes do not bypass checks via name-only allowlist.
4. **No `actor_id`/`role`/`policy` from the model or the client.** Server-side only.
5. **Existing SmartThings/Hue pairings are preserved.** No re-pairing. No migration. Paid SmartThings is acceptable.
6. **No secrets, private IPs, or `~/...`-style home paths in committed files.** Secret-scanning pre-commit guard catches this. If you need them locally, they live in `.env` (gitignored) or installation-local storage.
7. **Stop only at concrete boundaries:** missing credentials, target-repo ambiguity, hardware purchases, device re-pairing, live allowlist expansion, destructive migrations. Continue through all unblocked fixture work.
8. **Honor branch protection.** Open a PR; do not bypass review policy.

## Stage gates (full list in `docs/gates.md`, derived from plan §13)

| Stage | Gate |
|---|---|
| 0 | OpenClaw really starts; Bonsai produces a schema-checked sample through the adapter (or mock-bonsai with honest gate-partial); fixture mode needs no household credentials. |
| 1 | Direct fixture controls + persisted routines infrastructure work with OpenClaw and Bonsai stopped. Process restart never blindly replays uncertain commands. Model-supplied authority fields cannot affect execution policy. |
| 2 | Fixture discovery is deterministic. Pilot devices have verified identity, load type, route, evidence policy. Missing account credentials block only that connector. |
| 3 | Zero wrong-target/unauthorized proposals admitted to execution. Zero silently dropped exclusions in the gate suite. >=95% exact supported unambiguous interpretation. |
| 4 | Common lighting tasks in demo without visiting HA. Network drops do not replay taps. UI reports uncertainty accurately. |
| 5 | Saved routines run with OpenClaw + Bonsai stopped. Restart, duplicate occurrence, both DST transitions, stale registry versions, manual override races pass. |
| 6 | Clean supported environment installs using the candidate artifacts, with no source tree mounted. Install/upgrade/rollback/backup restoration demonstrated. |
| 7 | Another supported device can retrieve and install the delivered artifact. Remote SHA verified. |

## Repository layout

```
README.md          # what this is, install links, status
AGENTS.md          # this file
STATE.md           # progress record (plan §15 fields)
HEARTH_UPSTREAM.md # OpenClaw upstream commit + inspection notes
LICENSE
THIRD_PARTY_NOTICES.md
package.json         # workspace root, scripts wired here
pnpm-workspace.yaml
apps/control/       # hearth-control: API + executor + scheduler
apps/web/           # PWA
packages/contracts/ # shared types: contract, receipt, evidence, intent proposal
packages/registry/  # canonical device identity + overlay
packages/interpreter/ # grammar-first parser + Bonsai fallback resolver
packages/executor/  # executor + per-target evidence + receipts
packages/routines/  # durable scheduler
packages/ha-adapter/ # fake-HA by default, real HA by config
packages/discovery/ # LAN + hub + account importers + coverage report
packages/openclaw-adapter/ # restricted adapter into pinned OpenClaw
packages/cli/       # install / configure / doctor / backup / upgrade / rollback / uninstall
config/             # templates only (hearth.example.yaml, openclaw.example.json)
models/bonsai.lock.json
deploy/compose.yaml
scripts/            # install.sh, upgrade.sh, uninstall.sh
tests/{unit,integration,e2e,failure}/
eval/{commands,reports}/
fixtures/home/      # synthetic household
patches/CORE_PATCHES.md
docs/               # architecture, decisions, install, upgrade-and-rollback, discovery, operations, compatibility, reviews
.github/workflows/  # ci.yml, release.yml
```

## Working conventions

- **Commit small coherent slices.** Format: `agent | action | path | reason`.
- **No force-pushes.** Rebase before push when needed.
- **No `git rm` on vault files** (no vault files in this repo; rule inherited from the parent protocol anyway).
- **Single release requires every gate above it to pass.** A green Stage 6 means Stages 0-5 all held.
- **Tests must fail before they pass.** TDD where it earns its keep.

## Status

See `STATE.md` and `HEARTH_UPSTREAM.md`. The current Stage is recorded there after each coherent milestone.