from __future__ import annotations

import asyncio

from hearth_extract import ExtractRequest, ExtractionSchemaIn, extract


class FakeExtractor:
    def __init__(self) -> None:
        self.kwargs = None

    def extract(self, utterance, **kwargs):
        self.kwargs = kwargs
        return {
            "entities": {
                "device_target": [{"text": "lamps", "confidence": 0.86}],
                "room": [{"text": "master bedroom", "confidence": 0.93}],
            },
            "intent": {"label": "on", "confidence": 0.97},
        }


def test_extract_normalizes_gliner_v2_classification_and_spans(monkeypatch):
    import hearth_extract

    fake = FakeExtractor()
    monkeypatch.setattr(hearth_extract, "_extractor", fake)
    request = ExtractRequest(
        request_id="req-test",
        utterance="turn on the master bedroom lamps",
        schema_in=ExtractionSchemaIn(
            schema_version="1",
            entity_types=["device_target", "room"],
            classification_labels=["on", "off"],
            relations=[],
            known_aliases=[],
        ),
    )

    result = asyncio.run(extract(request))

    assert result["classifications"] == [
        {"label": "on", "span": "turn on the master bedroom lamps"}
    ]
    assert result["entities"] == {
        "device_target": ["lamps"],
        "room": ["master bedroom"],
    }
    assert result["confidence"] == 0.86
    assert fake.kwargs["schema"]["classifications"] == [
        {"task": "intent", "labels": ["on", "off"]}
    ]
    assert fake.kwargs["include_confidence"] is True


def test_multiple_classification_labels_are_marked_unresolved(monkeypatch):
    import hearth_extract

    class AmbiguousExtractor(FakeExtractor):
        def extract(self, utterance, **kwargs):
            return {"entities": {}, "intent": [
                {"label": "on", "confidence": 0.8},
                {"label": "off", "confidence": 0.7},
            ]}

    monkeypatch.setattr(hearth_extract, "_extractor", AmbiguousExtractor())
    request = ExtractRequest(
        request_id="req-ambiguous",
        utterance="change the lamp",
        schema_in=ExtractionSchemaIn(
            schema_version="1",
            entity_types=["device_target"],
            classification_labels=["on", "off"],
            relations=[],
            known_aliases=[],
        ),
    )

    result = asyncio.run(extract(request))

    assert result["classifications"] == []
    assert "intent" in result["unresolved"]
