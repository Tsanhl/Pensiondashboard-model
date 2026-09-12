#!/usr/bin/env python3
"""Exact tokenizer and prompt-loss-mask preflight for the T4 cumulative legal dataset.

This script never loads model weights and never trains. It uses MLX-LM's own
ChatDataset implementation so the measured prompt offset matches the installed
training runtime.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from mlx_lm.tokenizer_utils import load as load_tokenizer
from mlx_lm.tuner.datasets import ChatDataset


WORKSPACE = Path.cwd().resolve()
SCRIPT_PATH = Path(__file__).resolve()
ROOT = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else "training/evaluation-cycle-v2/30-cumulative-legal-training-20260902"
).resolve()
CANDIDATE_ROOT = ROOT / "rendered-candidate"
MODE = sys.argv[2] if len(sys.argv) > 2 else "candidate"
if MODE not in {"candidate", "final"}:
    raise RuntimeError("Second argument must be candidate or final")
FINAL_DATASET_ROOT = Path(
    sys.argv[3]
    if len(sys.argv) > 3
    else os.environ.get(
        "CUMULATIVE_VISIBLE_DATASET_ROOT",
        "training-data/private/evaluation-cycle-v2-cumulative-t4-legal-20260902",
    )
).resolve()
MODEL_ROOT = (WORKSPACE / "models/mlx/Qwen3-8B-4bit").resolve()
CONFIG_PATH = (WORKSPACE / "training/cumulative_t4_legal_mlx_config_20260902.yaml").resolve()
MANIFEST_PATH = (
    CANDIDATE_ROOT / "candidate-manifest.json"
    if MODE == "candidate"
    else FINAL_DATASET_ROOT / "dataset-manifest.json"
)
OUTPUT_PATH = ROOT / (
    "token-and-loss-mask-preflight.json"
    if MODE == "candidate"
    else "final-token-and-loss-mask-preflight.json"
)
if OUTPUT_PATH.exists():
    raise RuntimeError(f"Versioned token preflight output already exists: {OUTPUT_PATH}")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Invalid JSONL at {path}:{number}: {error}") from error
    return rows


def normalise(value: Any) -> str:
    value = re.sub(r"\{\{cite:[^}]+\}\}", "", str(value or "")).lower()
    return " ".join(re.findall(r"[^\W_]+", value, flags=re.UNICODE))


def percentile(values: list[int], fraction: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


for prerequisite in [MODEL_ROOT / "tokenizer.json", CONFIG_PATH, MANIFEST_PATH]:
    if not prerequisite.exists():
        raise RuntimeError(f"Token preflight prerequisite is missing: {prerequisite}")

manifest = read_json(MANIFEST_PATH)
expected_status = (
    "review_only_non_trainable_candidate"
    if MODE == "candidate"
    else "final_hash_bound_qualification_candidate"
)
if manifest.get("status") != expected_status:
    raise RuntimeError(f"Refusing to inspect unexpected {MODE} manifest status")
if manifest.get("training_authorised") is not False:
    raise RuntimeError("Preflight input manifest must explicitly deny training authority")

config_text = CONFIG_PATH.read_text(encoding="utf-8")
max_match = re.search(r"^max_seq_length:\s*(\d+)\s*$", config_text, flags=re.MULTILINE)
mask_match = re.search(r"^mask_prompt:\s*(true|false)\s*$", config_text, flags=re.MULTILINE)
if not max_match or not mask_match:
    raise RuntimeError("Training config does not explicitly record max_seq_length and mask_prompt")
max_sequence_length = int(max_match.group(1))
mask_prompt = mask_match.group(1) == "true"
if not mask_prompt:
    raise RuntimeError("Completion-only loss requires mask_prompt: true")

partitions = []
all_rows: list[tuple[str, dict[str, Any]]] = []
partition_root = CANDIDATE_ROOT if MODE == "candidate" else FINAL_DATASET_ROOT
for partition, filename, manifest_key in [
    ("train", "train.review.jsonl" if MODE == "candidate" else "train.jsonl", "train"),
    (
        "validation",
        "valid.review.jsonl" if MODE == "candidate" else "valid.jsonl",
        "validation",
    ),
]:
    path = partition_root / filename
    if not path.exists():
        raise RuntimeError(f"Rendered review partition is missing: {path}")
    rows = read_jsonl(path)
    expected = manifest[manifest_key]
    partitions.append(
        {
            "partition": partition,
            "path": str(path),
            "count": len(rows),
            "expected_count": expected["count"],
            "sha256": sha256_file(path),
            "expected_sha256": expected["sha256"],
            "manifest_match": len(rows) == expected["count"]
            and sha256_file(path) == expected["sha256"],
        }
    )
    all_rows.extend((partition, row) for row in rows)

tokenizer = load_tokenizer(MODEL_ROOT)
dataset = ChatDataset([row for _, row in all_rows], tokenizer, mask_prompt=True)
checks: list[dict[str, Any]] = []
for index, (partition, row) in enumerate(all_rows):
    messages = row.get("messages")
    training_id = row.get("metadata", {}).get("training_id", f"row-{index + 1}")
    roles = [message.get("role") for message in messages or []]
    shape_valid = (
        isinstance(messages, list)
        and len(messages) >= 3
        and roles[-1] == "assistant"
        and all(isinstance(message.get("content"), str) for message in messages)
    )
    if not shape_valid:
        checks.append(
            {
                "training_id": training_id,
                "partition": partition,
                "passed": False,
                "error": "invalid_chat_shape",
                "roles": roles,
            }
        )
        continue

    tokens, offset = dataset.process(row)
    prompt_tokens = tokenizer.apply_chat_template(
        messages[:-1], add_generation_prompt=True, return_dict=False
    )
    full_tokens = tokenizer.apply_chat_template(messages, return_dict=False)
    target = messages[-1]["content"]
    try:
        target_payload = json.loads(target)
    except json.JSONDecodeError:
        target_payload = None
    try:
        user_payload = json.loads(messages[-2]["content"])
    except json.JSONDecodeError:
        user_payload = None
    evidence_ids = {
        source.get("source_id")
        for source in (user_payload or {}).get("evidence", [])
        if source.get("source_id")
    }
    target_answer = target_payload.get("answer", "") if target_payload else ""
    target_citation_ids = (
        target_payload.get("citation_ids", []) if target_payload else None
    )
    target_marker_ids = list(
        dict.fromkeys(re.findall(r"\{\{cite:([^}]+)\}\}", target_answer))
    )
    prompt_text = "\n".join(message["content"] for message in messages[:-1])
    supervised_tokens = len(tokens) - offset
    effective_supervised_tokens = max(
        0, min(len(tokens), max_sequence_length) - offset
    )
    retention = (
        effective_supervised_tokens / supervised_tokens if supervised_tokens else 0.0
    )
    decoded_supervised = tokenizer.decode(tokens[offset:])
    target_normalised = normalise(target)
    answer_normalised = normalise(target_answer)
    decoded_normalised = normalise(decoded_supervised)
    target_is_substantial = len(answer_normalised.split()) >= 12
    target_in_prompt = target_is_substantial and answer_normalised in normalise(prompt_text)
    json_contract_valid = (
        isinstance(target_payload, dict)
        and sorted(target_payload.keys()) == ["answer", "citation_ids"]
        and isinstance(target_answer, str)
        and bool(target_answer.strip())
        and isinstance(target_citation_ids, list)
        and len(target_citation_ids) == len(set(target_citation_ids))
        and all(source_id in evidence_ids for source_id in target_citation_ids)
        and target_marker_ids == target_citation_ids
        and not re.search(r"\{\{cite:[^}]+\}\}", prompt_text)
    )
    row_checks = {
        "chat_shape": shape_valid,
        "metadata_training_boundary": (
            row.get("metadata", {}).get("review_only_candidate") is True
            if MODE == "candidate"
            else row.get("metadata", {}).get("review_only_candidate") is False
            and row.get("metadata", {}).get("owner_authorised_development") is True
        )
        and row.get("metadata", {}).get("training_authorised") is False,
        "mlx_offset_matches_prompt_template": offset == len(prompt_tokens),
        "mlx_full_template_matches": list(tokens) == list(full_tokens),
        "prompt_is_exact_token_prefix": list(tokens[:offset]) == list(prompt_tokens),
        "assistant_target_nonempty": bool(target.strip()),
        "live_json_answer_citation_ids_contract": json_contract_valid,
        "inline_marker_ids_exactly_match_citation_ids": (
            target_marker_ids == (target_citation_ids or [])
        ),
        "citation_markers_absent_from_prompt_and_evidence": not re.search(
            r"\{\{cite:[^}]+\}\}", prompt_text
        ),
        "assistant_has_supervised_tokens": supervised_tokens > 0,
        "decoded_supervised_contains_target": target_normalised in decoded_normalised,
        "target_not_in_prompt": not target_in_prompt,
        "within_max_sequence_length": len(tokens) <= max_sequence_length,
        "full_target_retained_at_max_length": retention == 1.0,
    }
    checks.append(
        {
            "training_id": training_id,
            "partition": partition,
            "cohort": row.get("metadata", {}).get("cohort"),
            "topic": row.get("metadata", {}).get("topic"),
            "total_tokens": len(tokens),
            "prompt_offset": offset,
            "supervised_tokens": supervised_tokens,
            "effective_supervised_tokens_at_max_length": effective_supervised_tokens,
            "target_retention_at_max_length": round(retention, 6),
            "passed": all(row_checks.values()),
            "checks": row_checks,
        }
    )

ids = [entry[1].get("metadata", {}).get("training_id") for entry in all_rows]
train_ids = {
    entry[1].get("metadata", {}).get("training_id")
    for entry in all_rows
    if entry[0] == "train"
}
validation_ids = {
    entry[1].get("metadata", {}).get("training_id")
    for entry in all_rows
    if entry[0] == "validation"
}
lengths = [entry["total_tokens"] for entry in checks if "total_tokens" in entry]
prompt_lengths = [entry["prompt_offset"] for entry in checks if "prompt_offset" in entry]
supervised_lengths = [
    entry["supervised_tokens"] for entry in checks if "supervised_tokens" in entry
]
over_limit = [
    {
        "training_id": entry["training_id"],
        "partition": entry["partition"],
        "cohort": entry.get("cohort"),
        "topic": entry.get("topic"),
        "total_tokens": entry["total_tokens"],
        "prompt_offset": entry["prompt_offset"],
        "supervised_tokens": entry["supervised_tokens"],
        "effective_supervised_tokens_at_max_length": entry[
            "effective_supervised_tokens_at_max_length"
        ],
        "target_retention_at_max_length": entry["target_retention_at_max_length"],
    }
    for entry in checks
    if entry.get("total_tokens", 0) > max_sequence_length
]
zero_effective_loss = [
    entry["training_id"]
    for entry in checks
    if entry.get("effective_supervised_tokens_at_max_length") == 0
]
failed_ids = [entry["training_id"] for entry in checks if not entry["passed"]]
global_checks = {
    "dataset_manifest_hashes_match": all(
        partition["manifest_match"] for partition in partitions
    ),
    "exact_unique_rows": len(ids) == int(manifest.get("total_count") or 0) and len(set(ids)) == len(ids) and len(ids) > 94,
    "partitions_disjoint": not (train_ids & validation_ids),
    "all_rows_have_exact_prompt_mask_boundary": all(
        entry.get("checks", {}).get("mlx_offset_matches_prompt_template")
        and entry.get("checks", {}).get("prompt_is_exact_token_prefix")
        for entry in checks
    ),
    "no_completion_target_echo_in_prompt": all(
        entry.get("checks", {}).get("target_not_in_prompt") for entry in checks
    ),
    "all_rows_fit_without_truncation": len(over_limit) == 0,
    "all_rows_retain_full_completion_target": all(
        entry.get("checks", {}).get("full_target_retained_at_max_length")
        for entry in checks
    ),
    "no_row_loses_all_supervised_tokens": len(zero_effective_loss) == 0,
}
passed = all(global_checks.values()) and not failed_ids
report = {
    "version": "cumulative-visible-token-and-loss-mask-preflight-v1",
    "generated_at": __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc
    ).isoformat(),
    "status": "passed" if passed else "failed_training_blocked",
    "scope": (
        "review_only_candidate" if MODE == "candidate" else "final_hash_bound_dataset"
    ),
    "passed": passed,
    "training_authorised": False,
    "training_started": False,
    "unseen_accessed": False,
    "runtime_contract": {
        "implementation": "mlx_lm.tuner.datasets.ChatDataset.process",
        "mask_prompt": mask_prompt,
        "max_sequence_length": max_sequence_length,
        "model_tokenizer_path": str(MODEL_ROOT),
        "tokenizer_json_sha256": sha256_file(MODEL_ROOT / "tokenizer.json"),
        "config_path": str(CONFIG_PATH),
        "config_sha256": sha256_file(CONFIG_PATH),
        "preflight_script_path": str(SCRIPT_PATH),
        "preflight_script_sha256": sha256_file(SCRIPT_PATH),
    },
    "partitions": partitions,
    "counts": {
        "total": len(ids),
        "train": len(train_ids),
        "validation": len(validation_ids),
        "failed_rows": len(failed_ids),
        "over_limit_rows": len(over_limit),
        "zero_effective_loss_rows": len(zero_effective_loss),
    },
    "token_lengths": {
        "minimum": min(lengths) if lengths else None,
        "median": percentile(lengths, 0.5),
        "p95": percentile(lengths, 0.95),
        "maximum": max(lengths) if lengths else None,
        "prompt_maximum": max(prompt_lengths) if prompt_lengths else None,
        "supervised_maximum": max(supervised_lengths) if supervised_lengths else None,
    },
    "global_checks": global_checks,
    "failed_ids": failed_ids,
    "zero_effective_loss_ids": zero_effective_loss,
    "over_limit": sorted(over_limit, key=lambda item: item["total_tokens"], reverse=True),
    "rows": checks,
    "limit": (
        "Candidate mode validates the review rendering and must be repeated in final mode. "
        "Final mode validates exact final JSONL but does not provide independent legal or release approval."
    ),
}
OUTPUT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(
    json.dumps(
        {
            "passed": passed,
            "total": len(ids),
            "train": len(train_ids),
            "validation": len(validation_ids),
            "max_sequence_length": max_sequence_length,
            "over_limit": len(over_limit),
            "zero_effective_loss": len(zero_effective_loss),
            "maximum_tokens": max(lengths) if lengths else None,
            "report": str(OUTPUT_PATH),
            "scope": report["scope"],
        },
        indent=2,
    )
)
raise SystemExit(0 if passed else 1)
