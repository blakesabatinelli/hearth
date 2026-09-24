# Hearth State

> Progress record per plan §15. Update at each meaningful milestone.

## Current stage

Stage 0 -  Repository and compatibility spike.

## Completed outputs

- 2026-09-24 -  Plan read in full (`HEARTH_HERMES_DEVELOPMENT_PLAN.md`, 573 lines).
- 2026-09-24 -  Git repo initialized at `/Users/blake.sabatinelli/Desktop/hearth`, branch `main`.
- 2026-09-24 -  Drift control plane initialized at `~/.hermes/state/drift/hearth-build/` with six files: CONTRACT, STATE, DECISIONS, EVIDENCE, FAILURES, COMPLETION.
- 2026-09-24 -  AC list pulled from plan §13 gates (AC-0.*, AC-1.*, AC-GH.*).
- 2026-09-24 -  Three decisions locked: mock-bonsai adapter for fixture/test; blakesabatinelli/hearth repo on first push; single coherent Stage 0+1 slice before fanning out.
- 2026-09-24 -  Project `AGENTS.md` written with hard rules, stage gates, layout, conventions.

## Tests actually run and results

- 2026-09-24 -  `gh repo view blakesabatinelli/hearth` returns "Could not resolve to a Repository" (slot free).
- 2026-09-24 -  `gh auth status` ✓ `blakesabatinelli` with `repo`, `workflow`, `gist` scopes.
- 2026-09-24 -  OpenClaw GitHub repo + docs.openclaw.ai gateway page both HTTP 200.

## Review findings fixed or outstanding

- (none yet)

## Compatibility and model versions

- OpenClaw: pin pending -  see `HEARTH_UPSTREAM.md` after Stage 0 inspection.
- Bonsai 27B: `models/bonsai.lock.json` drafted with structure; real weights + serving runtime round-trip deferred (gate-partial).
- Home Assistant: not pinned in code; integration is config-driven via `config/hearth.example.yaml`.

## Blocked items and specific reason

- Real Bonsai 27B weights + serving runtime round-trip -  user decision 2026-09-24 to build behind `BonsaiProvider` interface with `mock-bonsai` adapter and mark Stage 0 gate partial.
- Live HA credentials, Alexa account, SmartThings token, Hue bridge -  out of scope until Blake provides them (per plan §15, scoped blocker, not a project-wide blocker).

## Next executable task

Pin OpenClaw upstream commit (probe `https://github.com/openclaw/openclaw`, capture latest tag + HEAD, write `HEARTH_UPSTREAM.md`). Then scaffold pnpm workspace + package skeleton. Then write the fake-HA adapter interface contract. Then first coherent commit + push to `blakesabatinelli/hearth`.

## Git branch and last pushed commit

- Branch: `main`
- Last local commit: none yet
- Last pushed commit: none yet (repo not yet created)

## Release and installation status

No release yet. Stage 0 in progress.

## Household actuation mode

**Fixture-only.** No live HA, no live devices, no live Alexa, no live SmartThings, no live Hue. Per plan §9 + §15, this is the default until Blake supplies credentials and an explicit device allowlist.