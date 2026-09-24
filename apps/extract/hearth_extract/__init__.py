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
    schema = {
        "entities": req.schema_in.entity_types,
        "classifications": req.schema_in.classification_labels,
    }
    try:
        result = _extractor.extract(  # type: ignore
            req.utterance,
            entity_types=req.schema_in.entity_types,
            labels=req.schema_in.classification_labels,
        )
    except Exception as e:
        log.exception("gliner2 extract failed")
        raise HTTPException(status_code=500, detail=f"extract failed: {e}") from e
    # Return shape compatible with ExtractionResult.
    return {
        "request_id": req.request_id,
        "entities": result.get("entities", {}),
        "classifications": result.get("classifications", []),
        "relations": result.get("relations", []),
        "unresolved": result.get("unresolved", []),
        "confidence": float(result.get("confidence", 0.0)),
        "original_utterance": req.utterance,
    }


def main() -> None:
    import uvicorn

    host = os.environ.get("HEARTH_EXTRACT_HOST", "127.0.0.1")
    port = int(os.environ.get("HEARTH_EXTRACT_PORT", "8770"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()