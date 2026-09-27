"""hearth-extract: GLiNER2 inference sidecar.

Separate Python process called by hearth-control over a local HTTP
socket. Returns ExtractionResult per the contract schema in
packages/contracts/src/index.ts.

Source: ADR-2026-09-24-gliner2-required
Pin:    models/gliner2.lock.json
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# gliner2[local] import is at runtime so the sidecar can boot and
# report "degraded" even when the optional dep is missing.
try:
    from gliner2 import AutoExtractor  # type: ignore
    _GLINER2_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised on bare installs
    _GLINER2_AVAILABLE = False
    AutoExtractor = None  # type: ignore


log = logging.getLogger("hearth-extract")
logging.basicConfig(level=os.environ.get("HEARTH_EXTRACT_LOG_LEVEL", "INFO"))


CHECKPOINT_ID = os.environ.get(
    "HEARTH_GLINER2_CHECKPOINT", "fastino/gliner2.5-base-v1"
)


# Models mirror @hearth/contracts ExtractionSchema + ExtractionResult.
# Wire-compatible JSON shape; Hearth side validates via the TS types.
class ExtractionSchemaIn(BaseModel):
    schema_version: str
    entity_types: list[str]
    classification_labels: list[str]
    relations: list[dict]
    known_aliases: list[dict]


class ExtractRequest(BaseModel):
    request_id: str
    utterance: str
    schema_in: ExtractionSchemaIn = Field(alias="schema")


class HealthResponse(BaseModel):
    ready: bool
    checkpoint_id: str
    latency_ms_p50: Optional[float] = None
    degraded_reason: Optional[str] = None


app = FastAPI(title="hearth-extract", version="0.0.1")
_extractor = None  # type: ignore


@app.on_event("startup")
async def _load_model() -> None:
    global _extractor
    if not _GLINER2_AVAILABLE:
        log.warning(
            "gliner2 is not installed; hearth-extract will report degraded. "
            "Direct controls and saved routines continue; Ask surface falls back to grammar."
        )
        return
    try:
        log.info("loading GLiNER2 checkpoint %s", CHECKPOINT_ID)
        _extractor = AutoExtractor.from_pretrained(CHECKPOINT_ID)  # type: ignore
        log.info("GLiNER2 ready")
    except Exception as e:  # pragma: no cover - depends on network/install
        log.exception("GLiNER2 load failed")
        _extractor = None


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    if _extractor is None:
        return HealthResponse(
            ready=False,
            checkpoint_id=CHECKPOINT_ID,
            degraded_reason="gliner2 not installed or load failed",
        )
    return HealthResponse(
        ready=True,
        checkpoint_id=CHECKPOINT_ID,
        latency_ms_p50=None,
    )


@app.post("/extract")
async def extract(req: ExtractRequest) -> dict:
    if _extractor is None:
        raise HTTPException(
            status_code=503,
            detail="hearth-extract degraded: gliner2 not available",
        )
    # Build the schema dict for gliner2 from the request. Schema-driven
    # by design: pass only the entity types and labels relevant to this
    # request (built hearth-side from registry + active categories).
    # gliner2 v2.0.0's `extract(text, schema, threshold)` accepts a
    # dict with keys {"entities", "classifications", "relations"}:
    #   entities       = list[str] (normalized internally)
    #   classifications = list[dict] (each dict must have "task" key)
    #   relations       = list[dict]
    # Passing entity_types= and labels= as kwargs is the v1 API and
    # raises TypeError against the pinned v2.0.0 release.
    schema = {
        "entities": req.schema_in.entity_types,
        "classifications": [{
            "task": "intent",
            "labels": req.schema_in.classification_labels,
        }],
        "relations": req.schema_in.relations,
    }
    try:
        result = _extractor.extract(  # type: ignore
            req.utterance,
            schema=schema,
            threshold=0.5,
            include_confidence=True,
        )
    except TypeError as e:
        # Fallback: some legacy checkpoints still expose
        # extract_entities(text, [entity_types], threshold). Detect at
        # runtime so a checkpoint change doesn't break the sidecar.
        if "entity_types" in str(e) and hasattr(_extractor, "extract_entities"):
            result = _extractor.extract_entities(  # type: ignore
                req.utterance,
                req.schema_in.entity_types,
                threshold=0.5,
            )
        else:
            log.exception("gliner2 extract TypeError")
            raise HTTPException(status_code=500, detail=f"extract failed: {e}") from e
    except Exception as e:
        log.exception("gliner2 extract failed")
        raise HTTPException(status_code=500, detail=f"extract failed: {e}") from e
    entities, entity_confidences = _normalize_entities(result.get("entities", {}))
    classifications, intent_confidences = _normalize_classification(
        result.get("intent"), req.utterance, req.schema_in.classification_labels
    )
    unresolved = list(result.get("unresolved", []))
    if not classifications and "intent" not in unresolved:
        unresolved.append("intent")
    confidences = [*entity_confidences, *intent_confidences]
    confidence = min(confidences) if confidences else 0.0

    # Return the contract shape. GLiNER2 v2 returns each classification
    # under its task name and entities as attributed span objects when
    # include_confidence=True; neither shape matches ExtractionResult.
    return {
        "request_id": req.request_id,
        "entities": entities,
        "classifications": classifications,
        "relations": result.get("relations", []),
        "unresolved": unresolved,
        "confidence": confidence,
        "original_utterance": req.utterance,
    }


def _normalize_entities(raw_entities: object) -> tuple[dict[str, list[str]], list[float]]:
    if not isinstance(raw_entities, dict):
        return {}, []
    entities: dict[str, list[str]] = {}
    confidences: list[float] = []
    for name, raw_spans in raw_entities.items():
        spans = raw_spans if isinstance(raw_spans, list) else [raw_spans]
        normalized: list[str] = []
        for span in spans:
            if isinstance(span, str):
                text = span
            elif isinstance(span, dict):
                text = span.get("text", "")
                score = span.get("confidence")
                if isinstance(score, (int, float)):
                    confidences.append(float(score))
            elif isinstance(span, tuple) and span:
                text = span[0]
                if len(span) > 1 and isinstance(span[1], (int, float)):
                    confidences.append(float(span[1]))
            else:
                continue
            if isinstance(text, str) and text.strip() and text not in normalized:
                normalized.append(text.strip())
        entities[str(name)] = normalized
    return entities, confidences


def _normalize_classification(
    raw_intent: object,
    utterance: str,
    allowed_labels: list[str],
) -> tuple[list[dict[str, str]], list[float]]:
    if raw_intent is None:
        return [], []
    choices = raw_intent if isinstance(raw_intent, list) else [raw_intent]
    normalized: list[dict[str, str]] = []
    confidences: list[float] = []
    for choice in choices:
        if isinstance(choice, dict):
            label = choice.get("label")
            score = choice.get("confidence")
        else:
            label = choice
            score = None
        if isinstance(label, str) and label in allowed_labels:
            normalized.append({"label": label, "span": utterance})
            if isinstance(score, (int, float)):
                confidences.append(float(score))
    # A classification task is single-label. Multiple returned labels are
    # ambiguous and must not be converted into an executable proposal.
    if len(normalized) != 1:
        return [], confidences
    return normalized, confidences


def main() -> None:
    import uvicorn

    host = os.environ.get("HEARTH_EXTRACT_HOST", "127.0.0.1")
    port = int(os.environ.get("HEARTH_EXTRACT_PORT", "8770"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
