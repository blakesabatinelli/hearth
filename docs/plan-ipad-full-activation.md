# Hearth household activation and iPad access plan

Updated 2026-09-27

## Objective

Make every identified, supported household actuator available through Hearth,
record verified Stage 1 and Stage 3 gate results, deliver an iPad-first
control experience, and provide private remote access from the iPad through
Tailscale.
All device commands continue through the Hearth executor. GLiNER2 remains the
first model after the deterministic parser, with Bonsai used only where the
measured route requires it.

## Project plan and current status

This is the working plan for the next delivery. It orders work by dependency
and separates software work that can proceed locally from household actions
that need physical verification or an unlocked macOS session.

| Priority | Workstream | Current evidence | Next deliverable | Gate |
|---|---|---|---|---|
| P0 | Stage 1 | Fixture control (74), scheduler (20), and executor (36) suites pass with model providers stubbed unavailable. Restart recovery does not replay against stale, missing, or incomplete state. | None. Stage 1 fixture gate evidence is complete. | Stage 1 checklist complete. |
| P0 | Stage 3 | Grammar, GLiNER2-only, and combined paths pass all 200 frozen cases, with 150/150 exact supported cases, zero unsafe admissions, and no dropped exclusions. | Preserve the reports and keep this synthetic gate evidence linked to the corpus checksum. | Complete for the frozen synthetic corpus. |
| P1 | Device activation | The private HA review sheet contains 56 entities, 55 HA device IDs, current state for all 56, and the exact two enabled entities. Fifteen repeated-name groups contain 30 routes; 21 rows lack make/model metadata. | Physically resolve repeated names and missing model data, classify loads, then enable verified supported actuators in small batches. | Every supported physical actuator has a verified identity, route, policy, and feedback. |
| P1 | iPad interface | Overview, rooms, favorites, Ask, routines, attention, devices, and history screens are implemented. The command result explains decision source and no-op outcomes without raw receipts. All 46 web tests pass and the production build passes. Narrow viewport review confirms the full navigation wraps into visible touch rows. Actual iPad orientation and live-device acceptance remain open. | Review portrait and landscape on the iPad once private access is paired. | Core control and recovery tasks pass on the iPad in both orientations. |
| P1 | Managed startup | Four loopback-only LaunchAgents are installed for Bonsai, GLiNER2, Hearth control, and the production PWA. They read secrets from owner-only files, not plists. All are loaded and healthy. The production PWA was terminated gracefully and launchd restarted it with HTTP 200. | Verify the remaining services recover at their next managed restart and confirm startup after a user login. | Services restart after process exit and user login without replaying uncertain commands. |
| P2 | Private iPad access | The production gateway requires an allowlisted Serve identity for proxied tailnet traffic and allows direct access only for localhost hosts. The Tailscale client is not installed. The Homebrew installer requires a local administrator password, and macOS is locked. | Unlock the host, install/sign in to Tailscale locally, configure restricted Serve access, and pair the iPad. | Tailnet-only HTTPS access works from home and cellular, with no public Funnel route. |

### Immediate execution order

1. Complete. Review and freeze the synthetic Stage 3 corpus, finish all gate
   paths, and save the machine-readable reports. The fixture Stage 1 gate
   evidence is also complete.
2. Complete. Generated the installation-local `device-review.csv` from fresh
   HA registries and read-only state. Resolve duplicate routes and unknown
   load types with the household before enabling those entities. Do not use a
   domain-wide allowlist.
3. Activate verified supported devices in small room/category batches through
   Hearth's executor, checking fresh HA state and the corresponding receipt
   after each change.
4. Finish the iPad screens against the verified manifest, then exercise normal
   use, stale/offline state, session renewal, and no-replay behavior on the
   actual iPad after Tailscale onboarding and pairing.
5. Configure Tailscale Serve only after the production identity mapping,
   loopback bindings, and tailnet grants are reviewed. Test from both home Wi-Fi
   and cellular before calling the project usable remotely.

**External prerequisite:** Tailscale needs an interactive install/sign-in on
the always-on Mac. The last setup attempt could not proceed while macOS was
locked. Homebrew downloaded the current Tailscale package but its privileged
installer exited because it could not prompt for the macOS administrator
password. Unlock the host and complete the official Tailscale client
installation and onboarding, including local VPN configuration approval and
account sign-in. Enter any macOS password locally; never put it in chat or a
repo file. Tailnet account sign-in and policy changes also require the
household's Tailscale account.

**Current host state:** A fresh control doctor run passes all 9 checks. The
production gateway serves the current PWA and proxies healthy API responses;
`/readyz` reports `ready` with 56 device records. OpenClaw's pinned Gateway,
Home Assistant, GLiNER2, and Bonsai are also listening locally. The app exposes
two verified lamps for live actuation; the other 54 records remain visible and
read-only. Managed startup is installed and the production PWA restart has
been recovered by launchd. On 2026-09-27, the production PWA created an admin
session and returned all 56 records. The exact request "Turn on the master
bedroom lamps" resolved through grammar to two distinct enabled lights; the
executor returned `no-op` with both already satisfied, then fresh HA reads
confirmed both on. This verifies the command path without dispatching an
unneeded service call. The Tailscale client is not installed, the host is
locked, and no iPad is paired.

## Current baseline

- Hearth is running in live Home Assistant mode. The last readiness record
  reports 56 HA device records, but this count may include duplicate entities
  and does not establish 56 distinct physical devices.
- Only the two verified master-bedroom SmartThings lamps are in the physical
  actuation allowlist. Other devices are currently discovery-only.
- A SmartThings event-stream failure was recovered by reloading its existing
  Home Assistant entry. The integration may need monitoring while its upstream
  event-feed reliability is unresolved.
- Stage 1 fixture checks and Stage 3 corpus checks pass. The separate GLiNER2
  pilot still has 32 held-out examples; the local v7 checkpoint scored
  90.625% exact intent plus
  action-relevant entities, with 75% hold-until accuracy and a scene extraction
  issue. It is not the Stage 3 evaluation.
- The production PWA now has Home, Rooms, Favorites, Ask, Routines, Attention,
  History, and Devices screens, served through the same-origin gateway. The
  latest bundle was visually inspected at a narrow viewport and shows two
  live controls among 56 discovered records. Actual iPad portrait and
  landscape acceptance remains open. Development admin-session creation must
  stay behind the identity-restricted gateway for remote use.
- The current live discovery snapshot contains 56 records, not necessarily 56
  unique physical devices. It includes 46 lights, 8 switches whose load types
  are not classified, one lock, and one media player. Fifteen overlapping
  friendly-name groups have both Hue and SmartThings routes enabled; observed
  room or state disagreement means a matching name is not enough to select a
  route. Keep the current two-light live allowlist until each additional target
  has a verified physical identity.
- The private review sheet is stored under the Hearth runtime data directory
  with owner-only file permissions. It contains 56 entities, 55 distinct HA
  device registry IDs, 15 repeated friendly-name groups (30 routes), 21 rows
  without make/model details, and fresh state for all 56. HA device IDs group
  registry entries but do not prove that Hue and SmartThings entries refer to
  distinct physical devices.
- The reviewed, frozen Stage 3 corpus passes grammar, GLiNER2-only, and
  combined paths at 150/150 exact supported unambiguous cases, zero unsafe
  admissions, and zero dropped exclusions. The combined path used Bonsai on
  39 of 200 requests. The corpus checksum and machine-readable reports are in
  `docs/gates.md` and `eval/reports/`.
- The Bonsai-only 200-case diagnostic was started but stopped before completion
  to keep the local model available for interactive Hearth use. It is not a
  Stage 3 gate; the passing combined report already measures its fallback path.

## Work sequence

### 0. Establish the device inventory and safety policy

1. Refresh Home Assistant discovery and export an installation-local inventory
   of entity ID, friendly name, platform, physical device ID, room, enabled
   state, capabilities, current state, and last-reported time.
2. Reconcile HA entities against physical devices. Identify duplicate routes,
   disabled Hue duplicates, groups, scenes, sensors, diagnostic entities, and
   entities that are not independently actuable. Preserve existing Hue and
   SmartThings pairings.
3. Classify each unique physical actuator by load type, service mapping,
   reversibility, consequence of an incorrect command, and available feedback.
   Unknown switches and opaque scripts/scenes stay out of command scope until
   their load and effects are verified.
4. Produce a reviewed activation manifest with one canonical target per
   physical actuator, the HA entity route, actor permissions, and the evidence
   needed to confirm its state. Keep names and entity IDs in local installation
   data when they identify the household.
5. Define command policy by category. The requested goal is complete coverage
   of supported actuators after verification. Safety-critical classes such as
   locks, garage doors, alarms, and water valves need explicit category
   semantics and dedicated tests before they become live targets.

**Exit criteria:** every discovered entity has a disposition; every physical
actuator has a unique identity or a documented unresolved issue; the manifest
has no unresolved duplicates or silently excluded targets.

### 1. Stage 1 result and acceptance evidence

Run the fixture-control and routine checks with OpenClaw and Bonsai stopped or
disabled. Keep the test control service isolated from the live HA instance.

- Direct fixture controls dispatch through the executor and produce durable
  receipts without either model process.
- Saved routines persist across a control-service restart and execute without
  OpenClaw or Bonsai.
- Simulate a process stop at each dispatch boundary. Recovery marks uncertain
  work for reconciliation and never blindly replays a command.
- Inject model proposals containing actor IDs, roles, permissions, policy,
  allowlist, route, and expiry fields. Prove none can change server-derived
  authority or executor policy.
- Verify unavailable model services do not break direct controls, fixture
  discovery, routine storage, or recovery.

**Exit criteria:** fixture controls and routines work with both models stopped;
restart recovery does not replay uncertain work; model-supplied authority has
zero effect. Record reproducible commands and results in the stage report.

### 2. Stage 3 result and model-quality evidence

The reviewed, frozen 200-case corpus passes deterministic grammar, GLiNER2
plus resolver, and combined evaluation. A Bonsai-only diagnostic is optional
and is not a gate. Keep committed examples synthetic.
Keep household names and any local device aliases in installation-local
evaluation data.

The corpus should cover supported lights and other mapped actuators, rooms,
aliases, exclusions, compound requests, relative values, routines, scene
phrases, speech recognition errors, misleading names, ambiguity, unsupported
loads, and policy boundaries. Lock a held-out split before tuning GLiNER2.
Retain the currently running v5 checkpoint until the measured candidate passes
the same evaluation and category gates.

Report exact interpretation, wrong targets, unauthorized proposals, dropped
exclusions, unnecessary clarification, Bonsai invocation rate, latency, and
peak memory by command category. Train and compare GLiNER2 candidates locally;
do not send household data to a remote service.

**Stage 3 exit criteria:**

- Zero wrong-target and unauthorized proposals admitted to execution.
- Zero silently dropped exclusions.
- At least 95% exact interpretation for supported, unambiguous commands.
- Results reported by category, with weak categories routed to Bonsai or
  clarification rather than silently enabled.
- GLiNER2 is invoked before Bonsai on natural-language requests that are not
  fully handled by deterministic grammar. Bonsai invocation frequency is
  measured and minimized without bypassing the GLiNER2-first requirement.

### 3. Activate devices in reviewed batches

After Stage 1 passes, exercise each manifest target in fixture mode. After Stage
3 passes, add verified live targets to the exact per-entity allowlist in small
batches by category and room.

For each batch:

1. Confirm the physical identity and Home Assistant route using read-only
   observations.
2. Run the least disruptive supported state change through Hearth's executor.
3. Confirm the state through fresh HA evidence and verify the receipt reports
   the correct outcome.
4. Exercise unavailable, delayed, and stale-state paths. Confirm Hearth reports
   uncertainty honestly and does not replay a tap after network loss.
5. Record the device disposition and remove any target whose route, identity,
   capability, or feedback is uncertain.

**Exit criteria:** every supported, verified actuator in the manifest is
available through Hearth; sensors and diagnostic entities are explicitly
read-only; unsupported or safety-critical exceptions are listed with their
blocking evidence. No broad domain wildcard is used for actuation.

### 4. Design and implement the iPad-first Hearth interface

First produce landscape and portrait wireframes using the reviewed room and
device inventory. Then implement the approved design in the existing PWA.

Proposed information architecture:

- **Home:** room summaries, favorites, attention items, and concise household
  status.
- **Rooms:** large touch targets for each eligible device, current state, room
  filters, and supported controls such as brightness.
- **Ask:** natural-language requests with a visible routing explanation and a
  clear executor receipt.
- **Routines:** saved routines, schedules, pause/resume, and last-run result.
- **History:** confirmed, already-satisfied, failed, and uncertain outcomes.
- **Devices and access:** discovery status, supported capabilities, and why an
  entity is controllable or read-only.

Interaction and layout requirements:

- Responsive iPad landscape and portrait layouts, designed for touch and
  reachable controls.
- Show pending, confirmed, already-satisfied, failed, and uncertain results
  distinctly. A request is not shown as complete until executor evidence says
  it is complete.
- Display stale/offline status. Disable state-changing controls when the
  control service cannot be reached; never queue or replay commands offline.
- Preserve a low-friction control flow for the user's explicitly authorized
  routine actions. Keep category-specific safeguards for safety-critical loads.
- Support Safari Add to Home Screen, PWA icons, safe-area insets, and session
  renewal without exposing credentials in client storage.

**Exit criteria:** an iPad user can find a room, operate each enabled control,
ask a command, review its evidence, inspect history, and identify stale or
unsupported devices without using a desktop layout.

### 5. Provide private iPad connectivity with Tailscale

Use Tailscale Serve for tailnet-only HTTPS access. Do not use Tailscale Funnel
for the household control interface. Serve is designed to expose a local
service to the tailnet, and tailnet grants apply to the served service.

Recommended topology:

```text
iPad Safari / installed PWA
       |
       | Tailscale tailnet, HTTPS, grant limited to the Hearth web port
       v
Tailscale Serve on the always-on Hearth host
       |
       | loopback only
       v
Production web gateway: built PWA at /, Hearth API under /v1
       |
       +---- control service and executor
       +---- Home Assistant, GLiNER2, OpenClaw, and Bonsai remain private
```

Implementation steps:

1. Confirm the host can remain online with Tailscale, Hearth control, and the
   model sidecars available. Add managed startup and health recovery for the
   required services; document graceful shutdown and backup.
2. Build a production same-origin web endpoint. Serve the PWA bundle and proxy
   only its API paths to the loopback control service. Keep Home Assistant,
   OpenClaw, Bonsai, and the extractor off the tailnet listener.
3. Disable development admin-session creation. Add a production identity path
   that maps the authenticated Tailscale identity to server-side Hearth actor
   and role configuration. Never accept actor ID, role, or policy from the
   browser. Trust Serve identity headers only when the backend is bound to
   loopback and inaccessible through an alternate listener.
4. Configure Tailscale Serve HTTPS for the production web endpoint. Review the
   tailnet policy and add a narrow grant for the iPad identity or approved
   household user group to the Hearth host and web port only. Check that no
   existing broad grant defeats this restriction. Do not expose Home Assistant
   or model ports.
5. Install Tailscale on the iPad, join the same tailnet, open the private
   Serve URL in Safari, authenticate, and add Hearth to the Home Screen.
6. Test on the home network and over cellular. Confirm unauthorized tailnet
   devices cannot reach Hearth, direct API ports are unavailable, CSRF and
   session expiry work, and a disconnected iPad command is not replayed after
   reconnection.

**Exit criteria:** the iPad reaches Hearth using tailnet HTTPS from home and
away; only the approved identity reaches the production web port; direct
control, model, and Home Assistant services stay on loopback; no public Funnel
route exists; PWA authentication maps to server-side actor authority.

## Recommended milestone order

| Milestone | Depends on | Deliverable |
|---|---|---|
| A. Inventory and activation policy | Current live HA access | Reviewed household manifest and exceptions |
| B. Stage 1 gate | Fixture environment | Model-stopped control and routine evidence |
| C. Stage 3 gate | B, reviewed corpus | Evaluation report and gated GLiNER2 candidate |
| D. Device activation | A, B, C | Per-category live allowlist and test receipts |
| E. iPad design and PWA | A, D can use fixture data in parallel | Approved iPad layouts and implemented PWA |
| F. Tailscale access | E, production authentication | Private iPad path and remote-access verification |

## Operational constraints and references

- Existing Hue and SmartThings pairings stay intact. Do not reset bridges or
  migrate devices as part of activation.
- Every physical command goes through Hearth's executor, including direct UI
  controls and routines.
- The current Home Assistant SmartThings event-feed instability needs an
  operational recovery procedure and honest stale-state reporting until the
  upstream issue is resolved.
- Stage definitions and repository constraints are in `AGENTS.md`,
  `STATE.md`, and `docs/gates.md`.
- Tailscale recommends grants for new access policies. Serve is tailnet-only;
  Funnel is public. Serve forwards identity headers to a loopback backend and
  strips spoofed incoming identity headers. Review the [Serve documentation](https://tailscale.com/docs/features/tailscale-serve),
  [grants documentation](https://tailscale.com/docs/features/access-control/grants),
  and [Serve examples](https://tailscale.com/docs/reference/examples/serve)
  against the current tailnet before rollout.
