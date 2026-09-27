#!/usr/bin/env python3
"""Evaluate a local GLiNER2 checkpoint against its held-out pilot corpus."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from gliner2 import AutoExtractor

LABELS = [
    "on",
    "off",
    "set_brightness",
    "dim_by",
    "set_scene",
    "hold_until",
    "routine_trigger",
    "query_state",
]
ENTITY_TYPES = ["device_target", "room", "group", "exclusion", "time_expression", "value_expression"]
TARGET_ENTITY_TYPES = {"device_target", "room", "group"}


def relevant_entity_types(intent: str) -> set[str]:
    """Fields that can change the resolver's executable proposal for this intent."""
    targets = TARGET_ENTITY_TYPES | {"exclusion"}
    if intent in {"on", "off", "query_state"}:
        return targets
    if intent in {"set_brightness", "dim_by", "set_scene"}:
        return targets | {"value_expression"}
    if intent == "hold_until":
        return targets | {"time_expression"}
    if intent == "routine_trigger":
        # Routine names are semantic values, never device targets.
        return {"value_expression"}
    return set(ENTITY_TYPES)


def span_text(value: object) -> str:
    return value.get("text", "") if isinstance(value, dict) else str(value)


def label_value(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("label", ""))
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--eval-jsonl", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    model = AutoExtractor.from_pretrained(str(args.checkpoint), local_files_only=True)
    schema = {
        "entities": ENTITY_TYPES,
        "classifications": [{"task": "intent", "labels": LABELS}],
        "relations": [],
    }
    totals = defaultdict(lambda: {"count": 0, "intent_correct": 0, "entities_exact": 0, "complete_correct": 0})
    details = []
    with args.eval_jsonl.open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            expected_output = record["output"]
            expected_intent = expected_output["classifications"][0]["true_label"][0]
            predicted = model.extract(
                record["input"],
                schema=schema,
                threshold=0.5,
                include_confidence=True,
            )
            actual_intent = label_value(predicted.get("intent"))
            actual_entities = predicted.get("entities", {})
            expected_entities = expected_output.get("entities", {})
            normalized_expected: dict[str, list[str]] = {}
            normalized_actual: dict[str, list[str]] = {}
            entities_exact = True
            for entity_type in sorted(relevant_entity_types(expected_intent)):
                expected_values = expected_entities.get(entity_type, [])
                actual_values = actual_entities.get(entity_type, [])
                if not isinstance(actual_values, list):
                    actual_values = [actual_values] if actual_values else []
                actual_texts = [span_text(value).strip().casefold() for value in actual_values]
                expected_texts = [value.strip().casefold() for value in expected_values]
                normalized_expected[entity_type] = expected_texts
                normalized_actual[entity_type] = actual_texts
                if sorted(actual_texts) != sorted(expected_texts):
                    entities_exact = False
            correct_intent = actual_intent == expected_intent
            category = totals[expected_intent]
            category["count"] += 1
            category["intent_correct"] += int(correct_intent)
            category["entities_exact"] += int(entities_exact)
            category["complete_correct"] += int(correct_intent and entities_exact)
            details.append({
                "intent_expected": expected_intent,
                "intent_predicted": actual_intent,
                "intent_correct": correct_intent,
                "entities_exact": entities_exact,
                "entities_expected": normalized_expected,
                "entities_predicted": normalized_actual,
                "relevant_entity_types": sorted(relevant_entity_types(expected_intent)),
            })

    report = {
        "checkpoint": str(args.checkpoint),
        "held_out_examples": len(details),
        "intent_accuracy": sum(v["intent_correct"] for v in totals.values()) / max(1, len(details)),
        "exact_intent_and_entities": sum(v["complete_correct"] for v in totals.values()) / max(1, len(details)),
        "by_intent": {
            label: {
                **values,
                "intent_accuracy": values["intent_correct"] / max(1, values["count"]),
                "exact_intent_and_entities": values["complete_correct"] / max(1, values["count"]),
            }
            for label, values in totals.items()
        },
        "cases": details,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}, indent=2))


if __name__ == "__main__":
    main()
