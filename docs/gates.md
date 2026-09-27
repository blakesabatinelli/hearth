# Hearth stage gates

Updated 2026-09-27. A gate is complete only when its evidence is recorded and
all listed criteria pass. A package test pass alone does not close a live or
household verification requirement.

| Stage | Gate |
|---|---|
| 0 | OpenClaw starts; Bonsai returns a schema-checked sample through its adapter, or mock-bonsai is explicitly reported as gate-partial; fixture mode needs no household credentials. |
| 1 | Fixture controls and persisted routines work with OpenClaw and Bonsai stopped. Restart never blindly replays uncertain commands. Model-supplied authority cannot affect execution. |
| 2 | Fixture discovery is deterministic. Every pilot device has verified identity, load type, route, and evidence policy. Missing connector credentials block only that connector. |
| 3 | Zero wrong-target or unauthorized proposals reach execution. Zero exclusions are silently dropped. At least 95% exact interpretation for supported, unambiguous requests. GLiNER2 runs before Bonsai after grammar. |
| 4 | Common lighting tasks work in demo without opening Home Assistant. Network drops do not replay taps. The UI reports uncertainty accurately. |
| 5 | Saved routines run while OpenClaw and Bonsai are stopped. Restart, duplicate occurrence, both DST transitions, stale registry versions, and manual override races pass. |
| 6 | A clean supported environment installs from candidate artifacts with no source tree mounted. Install, upgrade, rollback, and backup restoration are demonstrated. |
| 7 | Another supported device retrieves and installs the delivered artifact. The remote SHA is verified. |

## Stage 1 evidence and commands

Run with fixture mode. The control tests inject fixture adapters and providers
explicitly stubbed as unavailable, so they do not call the active OpenClaw
Gateway, Bonsai server, or household Home Assistant instance:

```sh
HEARTH_FIXTURE_MODE=1 pnpm --filter @hearth/control test
pnpm --filter @hearth/scheduler test
pnpm --filter @hearth/executor test
```

The control tests cover direct fixture execution with both model providers
unavailable, server-derived authority, durable routine API behavior, and
executor receipts. Scheduler tests cover SQLite reopen persistence, recovery
of a pending occurrence as skipped, duplicate occurrence suppression, and
spring-forward and fall-back clock behavior. Executor tests cover restart
reconciliation: a fresh matching observation becomes a no-op, a fresh mismatch
permits one idempotent retry, and stale, missing, or incomplete state produces
an uncertain receipt without replay.

## Stage 2 live inventory evidence

Generate the installation-local review sheet from the same environment used to
start Hearth control. It includes current read-only state and the effective
exact entity allowlist. It writes the review sheet and a matching, comma-
separated `secrets/hearth-actuation-allowlist` file under the Hearth runtime
root with mode 600; do not move either file into the repository. The exporter
refuses to overwrite these files when the configured allowlist is empty unless
empty output is explicitly enabled. Manual identity, load, route, evidence,
and note columns are preserved across inventory refreshes by HA entity ID;
they do not change the live allowlist.

```sh
node scripts/export-device-review.mjs
```

The current sheet has 56 actuator entities, 55 HA device registry IDs, no
failed state reads, 15 repeated friendly-name groups with 30 routes, and 21
entries missing make/model metadata. The two current allowlisted entities are
marked enabled. HA registry device IDs aid route comparison but do not prove
which Hue and SmartThings entries refer to the same physical hardware. Stage 2
remains open until the household verifies physical identity, load, route, and
evidence policy for each supported target.

## Stage 3 evidence and commands

The 200-case corpus was reviewed and frozen on 2026-09-27. It has 10 categories,
150 supported cases, unique case IDs, and synthetic fixture names and IDs only.
Its SHA-256 is
`1b09aa83b56e32d920bc64cb74455bb043311fdbf3fc1437ddc9b9590b0f305a`.
Keep all household names and entity identifiers out of it. Build the package
output before using the evaluator. Run each path separately and preserve the
generated reports:

```sh
node scripts/evaluate-stage3.mjs grammar
HEARTH_EXTRACT_URL=http://127.0.0.1:8770 node scripts/evaluate-stage3.mjs gliner2
HEARTH_EXTRACT_URL=http://127.0.0.1:8770 \
  HEARTH_OPENCLAW_URL=http://127.0.0.1:18789 \
  HEARTH_GATEWAY_TOKEN="$(< "$HEARTH_SECRET_DIR/openclaw-gateway-token")" \
  node scripts/evaluate-stage3.mjs combined
```

The combined path must additionally report Bonsai invocation rate, mean
latency, and peak memory. Review failures by category. Do not mark Stage 3
complete if any unauthorized admission, wrong target, or dropped exclusion is
present, even when the supported exact rate exceeds 95%.

## Current evidence

- Stage 1 passes the fixture gate. Control (74), scheduler (20), and executor
  (36) tests pass with model providers unavailable in the harness. This covers
  direct controls, durable routines, SQLite reopen, authority rejection, DST
  behavior, uncertain-fire recovery, and no-replay when state evidence is not
  trustworthy.
- Grammar, GLiNER2-only, and combined paths pass the reviewed, frozen
  200-case synthetic corpus. Each reports 150/150 exact supported cases, zero
  wrong-target admissions, zero unauthorized admissions, zero dropped
  exclusions, and no sample failures. Combined called GLiNER2 39 times and
  Bonsai 39 times (19.5% of all cases), with 15,992.2 ms mean end-to-end
  latency and 50,229,312 bytes evaluator-process peak RSS. GLiNER2-only mean
  latency was 17.37 ms, with 47,722,304 bytes evaluator-process peak RSS.
  These RSS measurements exclude the model servers.
- The interpreter rejects ungrounded fallback targets, unresolved
  exclusions, multi-action fallback reductions, and intent/action mismatches.
  Stage 3 passes this synthetic corpus gate. Household device identity and
  route verification remain Stage 2 work and are not established by this
  evaluator.
