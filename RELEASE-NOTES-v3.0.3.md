# Hearth v3.0.3

Hardens the macOS host setup guide against the most common
"HEARTH_SECRET_DIR not set" failure mode. The previous release had a
variable definition in section 2 and usages in sections 7, 11, and 12
with no guard. Running the token-creation commands in a fresh shell
silently wrote to `/<token-name>` on the read-only system root, which
on macOS produced:

```
zsh: read-only file system: /openclaw-gateway-token
zsh: no such file or directory: /openclaw-gateway-token
```

## What changed

- **`docs/macos-host-setup.md` section 2** now ends with a
  `: "${HEARTH_SECRET_DIR:?...}"` guard plus an `echo` so the user can
  confirm the resolved path. Documents the option to persist
  `HEARTH_RUNTIME_ROOT`, `HEARTH_DATA_DIR`, `HEARTH_LOG_DIR`, and
  `HEARTH_SECRET_DIR` in `~/.zshenv` for cross-shell persistence.
- **Section 7 (OpenClaw gateway token)** adds the same guard, plus a
  `chmod 600` on the secret file, plus an `echo` confirming the path.
- **Section 11 (Home Assistant token)** adds the same guard.
- **Section 12 (session secret)** adds the same guard, plus a `chmod
  600` on the secret file.
- **Section 12 (control API startup)** switches the
  `HEARTH_SESSION_SECRET="$(< .../hearth-session-secret")` line to a
  `: "${HEARTH_SESSION_SECRET:?...}"` guard so the API refuses to
  start with an unset secret instead of silently producing empty-string
  sessions.

If a guard fires, the message tells the operator to re-run section 2
in that shell or source `~/.zshenv`. The previous version relied on
operators remembering to re-export `HEARTH_RUNTIME_ROOT` and friends in
every new shell, which is exactly the failure that produced the
read-only-filesystem error.

## Tests

No code changes. 197 tests still pass; portability OK.

## Upgrade from v3.0.2

```bash
git fetch origin --tags
git checkout v3.0.3
```

No install / rebuild needed; this release is documentation only.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
GLiNER2 `fastino/gliner2.5-base-v1`, Home Assistant credentials, and a
labeled evaluation corpus. A production-ready declaration is gated on a
live-resource end-to-end run; this release is fixture-mode only.

## Documentation status

All publication-facing docs on `main` are clean of personal
references; clone URLs use the `<owner>/hearth` placeholder.
