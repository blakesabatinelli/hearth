# Hearth v3.0.9

Fixes a bash function-ordering bug in `scripts/doctor.sh` and tightens
the SQLite parent-directory check.

## What changed

**`scripts/doctor.sh`:**

- The `check()` helper was defined mid-script but called near the
  top (the native-binding and sidecar checks). Bash resolves
  function names at call time, but only after the function has been
  parsed; calling `check()` before its definition surfaced as
  `check: command not found` on real installs and produced a broken
  summary.
- Moved `check()`, `http_status()`, `http_body()` to the top of the
  script, immediately after `set -euo pipefail`. Dropped the
  duplicate definitions further down.
- The SQLite check now reads `HEARTH_DATA_DIR` and distinguishes
  between "the database file's parent directory is missing and the
  configured data dir also doesn't exist" (real failure) vs "the
  configured data dir exists but the SQLite parent hasn't been
  created yet" (WARN with a hint).

## Tests

No code changes outside `scripts/doctor.sh`. 197 tests still pass;
typecheck clean; portability + Bonsai-lock + GLiNER2-lock verifiers
green; no personal references.

## Upgrade from v3.0.8

```bash
git fetch origin --tags
git checkout v3.0.9
```

No install / rebuild needed.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
Home Assistant credentials, and a labeled evaluation corpus. A
production-ready declaration is gated on a live-resource end-to-end
run; this release is fixture-mode only.

## Documentation status

All publication-facing docs on `main` are clean of personal
references; clone URLs use the `<owner>/hearth` placeholder.
