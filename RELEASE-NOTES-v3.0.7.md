# Hearth v3.0.7

Documentation-only release. The section 10a (Docker) install block
hit three issues on Apple Silicon during live testing.

## What changed

**`docs/macos-host-setup.md` section 10a:**

- **Network binding fix.** The original block used `--network=host`,
  but Apple Silicon Docker Desktop runs containers in a Linux VM
  under the hood and `--network=host` does not behave like a real
  Linux host. Switched to `-p 8123:8123`, which publishes the port
  to the Mac's loopback reliably.
- **Inline comments removed.** The original block had `# comment`
  lines interleaved with commands, which zsh interpreted as
  commands (`zsh: command not found: #`). Stripped the inline
  comments and moved the prose-only explanations into Markdown
  paragraphs above the code blocks.
- **Timezone hardcoded.** `systemsetup -gettimezone` requires Full
  Disk Access on modern macOS and is unreliable from a shell. The
  block now uses `TZ=America/Chicago` with a one-line note about
  editing it.

## Tests

No code changes. 197 tests still pass; portability + Bonsai-lock +
GLiNER2-lock verifiers green; no personal references in any doc.

## Upgrade from v3.0.6

```bash
git fetch origin --tags
git checkout v3.0.7
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
