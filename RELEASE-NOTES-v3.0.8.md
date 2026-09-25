# Hearth v3.0.8

Documentation-only release. Section 12's control-API startup block
now reads the session secret from disk on every startup, so it works
regardless of which shell created it.

## What changed

**`docs/macos-host-setup.md` section 12 (control API startup block).**

The previous block guarded `HEARTH_SESSION_SECRET` with
`: "${HEARTH_SESSION_SECRET:?must be set ...}"`. In practice this
fires whenever the operator ran the secret-creation block in shell A
and `node apps/control/dist/src/main.js` in shell B, even though the
secret file existed on disk. Replaced the guard with:

```bash
export HEARTH_SESSION_SECRET="$(< "$HEARTH_SECRET_DIR/hearth-session-secret")"
```

so the secret is read from disk on every API startup. The same
pattern is now used in the doctor invocation below.

The `# If you persisted the HEARTH_*_DIR lines to ~/.zshenv ...`
comment lines were also dropped from the code block (zsh was
interpreting them as commands). The prose explanation now sits above
the code block.

## Tests

No code changes. 197 tests still pass; portability + Bonsai-lock +
GLiNER2-lock verifiers green; no personal references in any doc.

## Upgrade from v3.0.7

```bash
git fetch origin --tags
git checkout v3.0.8
```

No install / rebuild needed; this release is documentation only.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
Home Assistant credentials, and a labeled evaluation corpus. A
production-ready declaration is gated on a live-resource end-to-end
run; this release is fixture-mode only.

## Documentation status

All publication-facing docs on `main` are clean of personal
references; clone URLs use the `<owner>/hearth` placeholder.
