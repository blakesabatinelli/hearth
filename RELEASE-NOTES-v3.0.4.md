# Hearth v3.0.4

Fixes the GLiNER2 sidecar so live `/v1/extract` requests succeed
against the pinned `gliner2==2.0.0`, and adds a one-shot sidecar
installer so a from-source install no longer requires six rounds of
`ModuleNotFoundError`.

## Bug fixed: sidecar called gliner2 v1 API

The previous sidecar called:

```python
extractor.extract(text, entity_types=..., labels=...)
```

which is the v1 API. `gliner2==2.0.0` takes `schema=` (a dict) and
`threshold=`, returning the same response shape. A live smoke test on
the deployment host surfaced this as:

```
extract failed: ExtractorRuntimeMixin.extract() got an unexpected
keyword argument 'entity_types'
```

The sidecar now passes `schema={"entities": [...], "classifications":
[...], "relations": [...]}`. There's a `TypeError` fallback to
`extract_entities()` for legacy span checkpoints so a checkpoint
change can't silently break the sidecar.

## Install hardening: sidecar venv is one-shot now

`scripts/install.sh` previously did not install the Python sidecar at
all. A fresh from-source install hit a sequence of:

- `No module named google.protobuf`
- `No module named torch`
- `No module named peft`

The new flow:

- New `apps/extract/requirements.txt` pins `fastapi>=0.115`,
  `uvicorn[standard]>=0.32`, `pydantic>=2.9`, `gliner2[local]>=2.0.0`,
  `protobuf>=4.25`. One source of truth for both from-source install
  and Dockerfile references.
- `install_gliner2_sidecar()` in `scripts/install.sh` creates
  `apps/extract/.venv`, installs `requirements.txt` with the
  CPU-only torch index, installs the sidecar editable, and
  smoke-imports `AutoExtractor`. Idempotent.
- `scripts/doctor.sh` now reports the sidecar venv as `FAIL` with a
  "rerun scripts/install.sh" hint when it's missing or broken.

## Tests

197 tests across 9 packages + apps; typecheck clean; portability
verifier green.

## Upgrade from v3.0.3

```bash
git fetch origin --tags
git checkout v3.0.4
git pull origin main
bash scripts/install.sh   # creates the sidecar venv on the deployment host
```

The new sidecar will pick up the schema fix automatically. The
running sidecar (uvicorn on port 8770) needs a restart to load the
new code:

```bash
pkill -f 'uvicorn hearth_extract' || true
cd ~/src/hearth
apps/extract/.venv/bin/uvicorn hearth_extract:app --host 127.0.0.1 --port 8770
```

Rerun the smoke test:

```bash
curl -sS http://127.0.0.1:8770/extract \
  -H 'Content-Type: application/json' \
  -d '{
    "request_id": "mac-smoke-1",
    "utterance": "turn off the kitchen lights",
    "schema": {
      "schema_version": "0.0.1",
      "entity_types": ["device_target", "room_target"],
      "classification_labels": ["on", "off"],
      "relations": [],
      "known_aliases": []
    }
  }' | jq .
```

Expected: a JSON body with `"entities": {...}` and
`"classifications": [...]`, status 200.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
Home Assistant credentials, and a labeled evaluation corpus. A
production-ready declaration is gated on a live-resource end-to-end
run; this release is fixture-mode only.

## Documentation status

All publication-facing docs on `main` are clean of personal
references; clone URLs use the `<owner>/hearth` placeholder.
