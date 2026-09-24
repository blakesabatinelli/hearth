# hearth-extract (Python sidecar)

GLiNER2 v2.0.0 inference service. Runs in a separate process from
`hearth-control`. The TypeScript side calls it over a local HTTP/Unix
socket (defined in `@hearth/extractor` adapter).

**Stack:** Python 3.10+, `gliner2[local]>=2.0.0` (pinned in
`models/gliner2.lock.json`), no other heavy deps.

**Default checkpoint:** `fastino/gliner2.5-base-v1` (boundary
architecture; Apache-2.0). Checkpoint downloads at install time from
the HF Hub; SHA verified against the lock.

## Protocol

- `GET /health` - returns `{ ready: bool, checkpoint_id, latency_ms_p50 }`.
- `POST /extract` - body `{ request_id, utterance, schema }`, returns
  `ExtractionResult` (shape in `packages/contracts/src/index.ts`).

## Failure modes

- If pip install fails (no network, restricted PyPI): installer reports
  `hearth-extract: degraded`. Direct controls + saved routines continue.
  Ask surface falls back to grammar-only; ambiguous requests get a
  clarification prompt rather than a wrong actuation.
- If checkpoint download fails: same as above; degraded language path.

## Development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
hearth-extract --host 127.0.0.1 --port 8770
```

Tests: `pytest tests/`

## Configuration

See `config/hearth.example.yaml` (added in Stage 1) for the
`extract:` section. The Hearth installer wires it into
`hearth-control`'s startup so the sidecar is launched before the API
binds its port.