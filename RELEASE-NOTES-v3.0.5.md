# Hearth v3.0.5

Fixes the second bug in the GLiNER2 sidecar's schema call. Live smoke
test against the deployment host now succeeds end-to-end.

## Bug fixed: classifications must be list[dict]

After v3.0.4 (which fixed `extract(text, schema=...)` vs
`extract(text, entity_types=...)`), a live smoke test produced:

```
extract failed: string indices must be integers, not 'str'
```

Root cause: gliner2 v2.0.0's `_build_schema_dicts_and_metadata`
internally reads `c["task"]` for each entry in
`schema["classifications"]`. The sidecar was passing a list of label
strings (`["on", "off"]`) instead of a list of dicts
(`[{"task": "on", "labels": ["on"]}, {"task": "off", "labels":
["off"]}]`).

Fix: convert each label into `{"task": label, "labels": [label]}`
before passing.

## Tests

197 tests across 9 packages + apps; typecheck clean; portability
verifier green. The Python sidecar itself is not unit-tested; the
test totals do not change for this release. End-to-end validation
against the deployment host's GLiNER2 checkpoint is what proves the
fix - see "How to verify" below.

## How to verify on the deployment host

```bash
cd ~/src/hearth
git pull origin main

# Stop the old sidecar (was running the v3.0.4 code that 500'd here)
pkill -9 -f 'uvicorn hearth_extract' 2>/dev/null || true
sleep 1

# Start fresh - picks up the v3.0.5 sidecar code automatically
apps/extract/.venv/bin/uvicorn hearth_extract:app \
  --host 127.0.0.1 --port 8770 \
  > /tmp/hearth-extract.log 2>&1 &

# Wait for "GLiNER2 ready"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if grep -q "GLiNER2 ready" /tmp/hearth-extract.log 2>/dev/null; then
    echo "sidecar ready after ${i}s"
    break
  fi
  sleep 1
done

# Smoke test
curl -sS -i http://127.0.0.1:8770/extract \
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
  }'
```

Expected: `HTTP/1.1 200 OK` with a JSON body containing `"entities"`
and `"classifications"`.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
Home Assistant credentials, and a labeled evaluation corpus. A
production-ready declaration is gated on a live-resource end-to-end
run; this release is fixture-mode only.

## Documentation status

All publication-facing docs on `main` are clean of personal
references; clone URLs use the `<owner>/hearth` placeholder.
