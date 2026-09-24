# ADR-2026-09-24-gliner2-required - GLiNER2 is required, not optional

| Field | Value |
|---|---|
| Date | 2026-09-24 |
| Status | ACCEPTED |
| Deciders | Blake Sabatinelli (correction directive), Hermes (proposer + implementer) |
| Related | HEARTH_HERMES_DEVELOPMENT_PLAN.md v3.0 §3 (Deferred list said "GLiNER2 remains an optional measured experiment after the baseline works") and §17 source [7] |
| Supersedes | The above passage of the plan |

## Context

The development plan v3.0 demoted GLiNER2 to "an optional measured experiment after the baseline works." That was a planning error on my part: the original Blueprint (HEARTH_BUILD_PLAN_2.md v2.1) treated GLiNER2 as the primary extraction layer, with Bonsai as the reasoning fallback for things GLiNER2 could not resolve. The plan review correctly flagged GLiNER2 limits and asked for measured evaluation, but in re-stating scope, it demoted GLiNER2 entirely. That was wrong on inspection: GLiNER2 is *schema-driven and CPU-first*, which is the opposite of Bonsai's profile. Demoting it forces every natural-language request through an LLM, which is more expensive, slower, and harder to constrain than the schema-driven path GLiNER2 was designed for.

Blake has now directed: GLiNER2 is a required part of the interpretation and decision-routing layer. The plan's demoted-language passages are superseded.

## Decision

GLiNER2 is the **first model invoked for natural-language requests**, after the deterministic grammar parser, and **before** Bonsai. The grammar parser remains the cheapest path. GLiNER2 is the schema-driven middle path. Bonsai is the contextual-reasoning last resort, called only when GLiNER2's output is incomplete AND the request clearly needs contextual reasoning.

Concretely:

1. **GLiNER2 is a first-class component.** Add its adapter, schemas, pinned checkpoint and runtime dependencies, health checks, and packaging to the project. Implementation: a separate `hearth-extract` Python sidecar (GLiNER2 is a Python library; do not force it into TypeScript at the expense of compatibility).
2. **Keep extraction separate from authority.** GLiNER2 proposes meaning. It cannot supply trusted actor identity, grant permissions, change the allowlist, or execute device commands. Bonsai has the same restriction (plan §7).
3. **Preserve uncertainty and the original request.** Pass the complete utterance to fallback interpretation, not just extracted fields. Missing exclusions, negation, unsupported clauses, or ambiguous references must not silently disappear. A high confidence score or valid JSON alone does not establish a correct interpretation.
4. **Define the routing contract explicitly.** Five outcomes: `ready_for_contract`, `needs_gliner2`, `needs_bonsai`, `needs_clarification`, `unsupported`. Use validated completeness checks, registry resolution, and measured thresholds. When necessary information is genuinely absent, ask the user rather than asking another model to guess.
5. **Prove its value on the evaluation suite.** Compare grammar-only, GLiNER2 + resolver, Bonsai-only, and the combined pipeline. Measure exact interpretation, wrong targets, dropped exclusions, unnecessary clarification, Bonsai invocation rate, latency, and memory. Include compound requests, pronouns, speech errors, and misleading device names.
6. **Gate automatic execution by command category.** GLiNER2 implementation + evaluation are required. Permission for its outputs to proceed without Bonsai depends on passing the relevant tests. If a category fails, route to Bonsai or clarification while retaining the GLiNER2 layer. Report the limitation, do not quietly remove the component.
7. **Include it in installation and failure testing.** A clean-device installation must provision the pinned GLiNER2 dependency without relying on the development environment. If it fails, direct controls and saved routines continue. Clearly report any degraded language path; do not silently introduce cloud inference.

## Implementation specifics

- **Repository:** `https://github.com/fastino-ai/GLiNER2`, tag `v2.0.0`, commit `3c913c7369301133d3b7699252074c4303ada50e`, **Apache-2.0**.
- **PyPI:** `gliner2==2.0.0`, requires Python ≥ 3.10.
- **Default checkpoint:** `fastino/gliner2.5-base-v1` (boundary architecture; supports long utterances).
- **Sidecar:** `hearth-extract` Python service runs the model locally; `hearth-control` calls it over a local HTTP/Unix socket.
- **Lock file:** `models/gliner2.lock.json` (committed) records PyPI version, GitHub tag, commit, runtime constraints, default checkpoint. Weights download at install time from HF Hub; no weights in the repo (plan §11).

## Compatibility implications

- **Stage 0 gate (plan §13):** now also requires "GLiNER2 produces a schema-checked sample through the adapter." `mock-gliner2` adapter stands in for tests/CI; real checkpoint + serving runtime round-trip deferred to Stage 3 when the eval suite exists. Stage 0 gate goes from "partial" (Bonsai deferred) to "partial" (Bonsai + GLiNER2 deferred). Still honest; structural evidence complete.
- **Stage 1:** add a new package `@hearth/extractor` for the GLiNER2 adapter in `hearth-control`. Add a new Python sidecar `apps/extract/` with its own pinning (Python dependencies, model checkpoint).
- **Stage 3:** add GLiNER2 to the eval suite as a fourth axis (grammar-only / GLiNER2 + resolver / Bonsai-only / combined).
- **Stage 6 (install):** the installer provisions `gliner2` via pip in a venv, downloads the checkpoint from HF Hub, and starts the sidecar. If pip install fails (no network, restricted PyPI), the installer reports `hearth-extract: degraded` and Ask/grammar-only mode continues to work.
- **Compatibility manifest (plan §12):** add GLiNER2 row with PyPI version, GitHub commit, checkpoint ID, Python min, license.

## Consequences

- + Natural-language requests are schema-driven, fast, and bounded.
- + Bonsai invocation rate drops, lowering memory/latency/cost.
- + Routing decisions are explicit; the user can see why something routed where.
- - One more moving part (the Python sidecar) and one more dependency install path.
- - Eval suite gets bigger.
- - Author must verify that GLiNER2 path meets the gate; if it doesn't, that category is gated to Bonsai/clarification rather than silently removed (per Blake's directive).

## Verification

- Re-ran: contracts package compiles + 7/7 tests pass with new `ExtractionProvider`, `ExtractionResult`, `RoutingDecision` types.
- Re-ran: `node scripts/verify-gliner2-lock.mjs` exits 0.
- Re-ran: portability + bonsai + gliner2 lock verifications all green.
- Re-ran: `python3 ~/.hermes/skills/drift-control/scripts/completion_gate.py hearth-build` reports Stage 0 ACs all passing after new ACs added for GLiNER2.

## Reversal conditions

- GLiNER2 eval shows it is consistently dominated by Bonsai or grammar on the Hearth eval suite; OR
- GLiNER2 dependency install fails on supported profiles (no compatible Python, no compatible CPU); OR
- A regulatory/compliance issue surfaces that the Apache-2.0 license cannot satisfy.

In any of these, the layer stays in the repo as a measured-but-degraded path; we do not silently remove it.