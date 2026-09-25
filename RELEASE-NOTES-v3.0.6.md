# Hearth v3.0.6

Documentation-only release. The macOS host setup guide no longer
routes you into VirtualBox by default; it offers Home Assistant
Container (Docker) as the recommended path and keeps VirtualBox as an
explicit optional alternative.

## What changed

**`docs/macos-host-setup.md` section 10** is now split:

- **10a. Recommended: Home Assistant Container via Docker.** A
  `docker run --network=host -v ~/ha-config:/config
  homeassistant/home-assistant:stable` invocation with a readiness
  loop. No virtual machine, no kernel modules, no `brew install
  --cask virtualbox`.
- **10b. Optional: Home Assistant OS in a VirtualBox VM.** Kept
  verbatim for users who specifically need HA OS (supervisor add-ons,
  etc.), but the section is now explicitly framed as the heavier
  alternative.

Both routes document the `HEARTH_HA_URL` value the control service
needs and the clean-shutdown procedure.

**Section 14 (cleanup)** previously said "shut down the Home
Assistant VM from Home Assistant or VirtualBox" without scoping it to
the VirtualBox route. Now it's split:

- VirtualBox route: shut down via the HA UI or VirtualBox's ACPI
  Shutdown.
- Docker route: `docker stop homeassistant`.

**`RELEASE-NOTES-v3.0.5.md`** had two U+2014 em-dashes that snuck in
while drafting. Replaced with ASCII `-`. The portability verifier
catches this; fixing it here so the `main` tree is clean again.

## Tests

No code changes. 197 tests still pass; portability + Bonsai-lock +
GLiNER2-lock verifiers green; no personal references in any doc.

## Upgrade from v3.0.5

```bash
git fetch origin --tags
git checkout v3.0.6
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
