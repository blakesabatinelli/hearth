#!/usr/bin/env python3
"""LoRA fine-tune the pinned GLiNER2 checkpoint without uploading data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
# PEFT 0.21 checks this attribute while injecting LoRA modules. Torch 2.14
# exposes it only after importing the distributed tensor package.
import torch.distributed.tensor  # noqa: F401

from gliner2 import AutoExtractor
from gliner2.training import ExtractorTrainer, TrainingConfig
from peft import PeftModel


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model", required=True, help="Pinned model ID or local snapshot path")
    parser.add_argument("--train-jsonl", type=Path, required=True)
    parser.add_argument("--eval-jsonl", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="Local-only checkpoint directory")
    parser.add_argument("--max-steps", type=int, default=60)
    args = parser.parse_args()
    if not args.train_jsonl.is_file() or not args.eval_jsonl.is_file():
        parser.error("training and held-out JSONL files must both exist")
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        parser.error("output directory must be empty; refusing to overwrite a model")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    model = AutoExtractor.from_pretrained(args.base_model, local_files_only=True)
    config = TrainingConfig(
        output_dir=str(args.output_dir),
        experiment_name="hearth-local-pilot",
        num_epochs=3,
        max_steps=args.max_steps,
        batch_size=2,
        # GLiNER2 v2.0.0 evaluation batching expects identical dynamic
        # entity schemas within a batch. This pilot deliberately includes
        # different request families, so keep held-out evaluation at 1.
        eval_batch_size=1,
        gradient_accumulation_steps=1,
        encoder_lr=2e-5,
        task_lr=5e-4,
        # v2.0.0 boundary evaluator assumes identical entity schema keys
        # across held-out samples. We evaluate this mixed pilot corpus with
        # direct extraction after training instead of its broken batch path.
        eval_strategy="no",
        save_best=False,
        save_total_limit=1,
        logging_steps=5,
        num_workers=0,
        pin_memory=False,
        max_len=96,
        fp16=False,
        bf16=False,
        fused_optimizer=False,
        compile_model=False,
        deterministic=True,
        use_lora=True,
        lora_r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        save_adapter_only=False,
        report_to_wandb=False,
    )
    trainer = ExtractorTrainer(model, config)
    summary = trainer.train(str(args.train_jsonl))
    final_checkpoint = args.output_dir / "final"
    if not final_checkpoint.is_dir():
        raise RuntimeError("GLiNER2 trainer completed without saving a final checkpoint")
    inference_checkpoint = final_checkpoint
    if (final_checkpoint / "adapter_config.json").is_file():
        # GLiNER2 v2.0.0's full-checkpoint branch saves through PeftModel,
        # which still writes PEFT adapter files after merging. Re-load the
        # adapter and merge it into the base model so AutoExtractor can load
        # the resulting checkpoint directly at sidecar startup.
        base = AutoExtractor.from_pretrained(args.base_model, local_files_only=True)
        adapted = PeftModel.from_pretrained(base, str(final_checkpoint))
        merged = adapted.merge_and_unload()
        inference_checkpoint = args.output_dir / "merged"
        inference_checkpoint.mkdir(parents=True, exist_ok=True)
        merged.save_pretrained(str(inference_checkpoint))
    report = {
        "base_model": args.base_model,
        "checkpoint": str(inference_checkpoint),
        "train_examples": sum(1 for _ in args.train_jsonl.open(encoding="utf-8")),
        "eval_examples": sum(1 for _ in args.eval_jsonl.open(encoding="utf-8")),
        "training_summary": summary,
    }
    (args.output_dir / "hearth-training-report.json").write_text(
        json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
