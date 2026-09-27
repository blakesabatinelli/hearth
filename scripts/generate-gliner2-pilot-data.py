#!/usr/bin/env python3
"""Create a small, local-only GLiNER2 pilot corpus from approved device names."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from gliner2.training import Classification, InputExample

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


def example(text: str, label: str, entities: dict[str, list[str]]) -> dict:
    item = InputExample(
        text=text,
        entities=entities,
        classifications=[Classification(task="intent", labels=LABELS, true_label=label)],
    )
    return item.to_dict()


def build_corpus(devices: list[str], room: str) -> tuple[list[dict], list[dict]]:
    train: list[dict] = []
    evaluate: list[dict] = []

    def add(destination: list[dict], text: str, label: str, **entities: list[str]) -> None:
        destination.append(example(text, label, entities))

    train_state_templates = {
        "on": [
            "Turn on {device}.",
            "Switch {device} on.",
            "Please turn on the {device}.",
            "Could you switch the {device} on?",
            "Activate {device}.",
            "I want {device} on.",
        ],
        "off": [
            "Turn off {device}.",
            "Switch {device} off.",
            "Please turn off the {device}.",
            "Could you switch the {device} off?",
            "Deactivate {device}.",
            "I want {device} off.",
        ],
    }
    eval_state_templates = {
        "on": ["Power up {device}.", "Can you light up {device}?"],
        "off": ["Power down {device}.", "Can you shut off {device}?"],
    }
    for label, templates in train_state_templates.items():
        for device in devices:
            for template in templates:
                add(train, template.format(device=device), label, device_target=[device])
        for device in devices:
            for template in eval_state_templates[label]:
                add(evaluate, template.format(device=device), label, device_target=[device])

    room_templates = {
        "on": [
            "Turn on the lamps in {room}.",
            "Switch all lamps in {room} on.",
            "Please turn the {room} lamps on.",
            "Light the lamps in {room}.",
            "Could you turn on every lamp in {room}?",
            "I want the lamps in {room} on.",
            "Activate every lamp in {room}.",
            "Make every lamp in {room} active.",
        ],
        "off": [
            "Turn off the lamps in {room}.",
            "Switch all lamps in {room} off.",
            "Please turn the {room} lamps off.",
            "Switch off the lamps in {room}.",
            "Could you turn off every lamp in {room}?",
            "I want the lamps in {room} off.",
            "Deactivate every lamp in {room}.",
            "Make every lamp in {room} inactive.",
        ],
    }
    eval_room_templates = {
        "on": ["Could you switch on the lamps located in {room}?", "Make sure the {room} lamps are on."],
        "off": ["Could you switch off the lamps located in {room}?", "Make sure the {room} lamps are off."],
    }
    for label, templates in room_templates.items():
        for template in templates:
            add(train, template.format(room=room), label, device_target=["lamps"], room=[room])
        for template in eval_room_templates[label]:
            add(evaluate, template.format(room=room), label, device_target=["lamps"], room=[room])

    for device in devices:
        query_train = [
            "Is {device} on?",
            "Check whether {device} is on.",
            "Tell me the current state of {device}.",
            "What is happening with {device}?",
            "Is {device} currently running?",
            "What state is {device} in?",
        ]
        query_eval = ["Could you check the status of {device}?", "Show me the state of {device}."]
        for template in query_train:
            add(train, template.format(device=device), "query_state", device_target=[device])
        for template in query_eval:
            add(evaluate, template.format(device=device), "query_state", device_target=[device])

        brightness_train = [
            ("Set {device} to 40 percent.", "40 percent"),
            ("Make {device} 70% bright.", "70%"),
            ("Set the brightness of {device} to 25 percent.", "25 percent"),
        ]
        brightness_eval = [
            ("Put {device} at 55 percent brightness.", "55 percent"),
            ("Set {device} to 80%.", "80%"),
        ]
        for template, value in brightness_train:
            add(train, template.format(device=device), "set_brightness", device_target=[device], value_expression=[value])
        for template, value in brightness_eval:
            add(evaluate, template.format(device=device), "set_brightness", device_target=[device], value_expression=[value])

        dim_train = [
            ("Dim {device} by 10 percent.", "10 percent"),
            ("Lower {device} brightness by 15%.", "15%"),
            ("Reduce {device} by 20 percent.", "20 percent"),
        ]
        dim_eval = [
            ("Dim the brightness on {device} by 30 percent.", "30 percent"),
            ("Turn {device} down by 5%.", "5%"),
        ]
        for template, value in dim_train:
            add(train, template.format(device=device), "dim_by", device_target=[device], value_expression=[value])
        for template, value in dim_eval:
            add(evaluate, template.format(device=device), "dim_by", device_target=[device], value_expression=[value])

        hold_train = [
            ("Turn off {device} until {time}.", "midnight"),
            ("Keep {device} on until {time}.", "sunrise"),
            ("Switch off {device} until {time}.", "sunset"),
            ("Have {device} remain off until {time}.", "6 AM"),
            ("Keep {device} off through {time}.", "midnight"),
            ("Leave {device} off until {time}.", "sunset"),
            ("Leave {device} switched off through {time}.", "sunset"),
            ("Ensure {device} stays on until {time}.", "sunrise"),
            ("Schedule {device} to stay off up to {time}.", "6 AM"),
        ]
        hold_eval = [
            ("Please have {device} stay off up to {time}.", "midnight"),
            ("Leave {device} switched off through {time}.", "sunrise"),
        ]
        for template, time in hold_train:
            add(train, template.format(device=device, time=time), "hold_until", device_target=[device], time_expression=[time])
        for template, time in hold_eval:
            add(evaluate, template.format(device=device, time=time), "hold_until", device_target=[device], time_expression=[time])

    for label, scene in [("reading", "reading"), ("evening", "evening"), ("movie", "movie")]:
        add(train, f"Set {room} to the {scene} scene.", "set_scene", room=[room], value_expression=[scene])
        add(train, f"Activate the {scene} scene in {room}.", "set_scene", room=[room], value_expression=[scene])
        add(train, f"Switch {room} to {scene} scene.", "set_scene", room=[room], value_expression=[scene])
    add(evaluate, f"Activate the {room} reading scene.", "set_scene", room=[room], value_expression=["reading"])
    add(evaluate, f"Switch {room} to movie scene.", "set_scene", room=[room], value_expression=["movie"])

    routine = "bedtime"
    for text in [f"Run the {routine} routine.", f"Start my {routine} routine.", f"Please run {routine}."]:
        add(train, text, "routine_trigger", value_expression=[routine])
    add(evaluate, f"Execute the {routine} routine.", "routine_trigger", value_expression=[routine])
    # The interpreter treats routine names as values, never devices, so do
    # not train GLiNER2 to hallucinate a device_target for a routine phrase.
    add(evaluate, f"Trigger {routine}.", "routine_trigger", value_expression=[routine])

    return train, evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--room", required=True, help="Exact room name as imported from Home Assistant")
    parser.add_argument("--device", action="append", required=True, help="Exact approved device name, repeat once per device")
    parser.add_argument("--output-dir", type=Path, required=True, help="Local-only output directory outside the repository")
    args = parser.parse_args()
    if len(args.device) < 2:
        parser.error("at least two device names are required for the pilot corpus")

    train, evaluate = build_corpus(args.device, args.room)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, records in [("train.jsonl", train), ("eval.jsonl", evaluate)]:
        path = args.output_dir / name
        with path.open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        path.chmod(0o600)
    print(f"Wrote {len(train)} training examples and {len(evaluate)} held-out examples to the selected local directory.")


if __name__ == "__main__":
    main()
