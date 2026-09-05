"""Single-request, explicitly pinned MLX worker. Protocol is JSON lines on stdio.

The parent owns deadlines and kills this process on disconnect, including during
Metal prefill (which cannot be reliably interrupted by a Python cancellation flag).
No request can select a different model or adapter. This is a local test runtime.
"""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
from pinned_prompt_cache import SystemPrefixCache


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def emit(payload):
    print(json.dumps(payload), flush=True)


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def directory_records(root):
    records = []
    def walk(current):
        for path in sorted(current.iterdir(), key=lambda value: value.name):
            relative = str(path.relative_to(root))
            if path.is_symlink():
                target = path.resolve(strict=True)
                records.append({"path":relative,"type":"symlink","link_target":os.readlink(path),"target_realpath":str(target),"bytes":target.stat().st_size,"sha256":digest(target)})
            elif path.is_dir():
                records.append({"path":relative,"type":"directory"})
                walk(path)
            elif path.is_file():
                records.append({"path":relative,"type":"file","bytes":path.stat().st_size,"sha256":digest(path)})
            else:
                raise ValueError(f"Unsupported base-model artifact type: {path}")
    walk(root)
    return sorted(records,key=lambda value:value["path"])


def verify_base_directory(base,runtime):
    manifest_path = Path(runtime["base_model_directory_manifest_path"]).resolve(strict=True)
    if digest(manifest_path) != runtime["base_model_directory_manifest_sha256"]:
        raise ValueError("Base-model directory manifest hash mismatch")
    manifest = json.loads(manifest_path.read_text())
    records = directory_records(base)
    records_sha256 = canonical_hash(records)
    if manifest.get("version") != "base-model-directory-manifest-v1" or Path(manifest.get("root", "")).resolve() != base or manifest.get("records_sha256") != canonical_hash(manifest.get("records", [])) or records != manifest.get("records") or records_sha256 != runtime["base_model_directory_sha256"]:
        raise ValueError("Complete base-model directory identity mismatch")


def main():
    checkpoint_path = Path(sys.argv[1]).resolve()
    runtime = json.loads(sys.argv[2])
    required_runtime = {
        "max_tokens", "temperature", "top_p", "seed", "context_limit_tokens", "prefill_step_size",
        "cache_limit_bytes", "enable_thinking", "system_prefix_cache", "trust_remote_code", "add_generation_prompt",
        "base_model_directory_manifest_path", "base_model_directory_manifest_sha256", "base_model_directory_sha256",
    }
    if set(runtime) != required_runtime:
        raise ValueError("Pinned inference configuration is incomplete or contains unknown settings")
    if not (sys.flags.isolated and sys.flags.no_user_site and sys.flags.ignore_environment and sys.flags.safe_path and sys.flags.dont_write_bytecode):
        raise ValueError("Pinned model worker requires isolated Python startup with bytecode writes disabled")
    checkpoint = json.loads(checkpoint_path.read_text())
    training = json.loads((checkpoint_path.parent / "training-run-manifest.json").read_text())
    base = Path(training["base_model"]["path"]).resolve()
    if runtime["base_model_directory_manifest_path"]:
        verify_base_directory(base,runtime)
    adapter = Path(checkpoint["selected_adapter_path"]).resolve()
    expected = {
        base / "model.safetensors": training["base_model"]["model_sha256"],
        adapter / "adapters.safetensors": checkpoint["adapter_sha256"],
        adapter / "adapter_config.json": checkpoint["adapter_config_sha256"],
    }
    for path, sha in expected.items():
        if digest(path) != sha:
            raise ValueError(f"Pinned artifact hash mismatch: {path.name}")
    version = importlib.metadata.version("mlx-lm")
    if version != "0.31.3":
        raise ValueError(f"Unreviewed mlx-lm version: {version}")
    # Keep diagnostic/library output off the machine-readable protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        from mlx_lm import load, stream_generate
        from mlx_lm.sample_utils import make_sampler
        from mlx_lm.models.cache import make_prompt_cache

        mx.set_cache_limit(runtime["cache_limit_bytes"])
        model, tokenizer = load(str(base), adapter_path=str(adapter),
                                tokenizer_config={"trust_remote_code": runtime["trust_remote_code"]})
        mx.eval(model.parameters())
        lora_modules = sum(hasattr(module, "lora_a") for _, module in model.named_modules())
        if not lora_modules:
            raise ValueError("Selected adapter did not create any LoRA modules")
    identity = {
        "id": f"{checkpoint['model_version']}-step{checkpoint['selected_iteration']}",
        "base_path": str(base), "base_sha256": training["base_model"]["model_sha256"],
        "adapter_path": str(adapter), "adapter_sha256": checkpoint["adapter_sha256"],
        "adapter_config_sha256": checkpoint["adapter_config_sha256"],
        "checkpoint_sha256": digest(checkpoint_path),
        "tokenizer_sha256": digest(base / "tokenizer.json"),
        "model_config_sha256": digest(base / "config.json"),
        "tokenizer_config_sha256": digest(base / "tokenizer_config.json"),
        "mlx_lm_version": version, "mlx_version": importlib.metadata.version("mlx"),
        "worker_sha256": digest(__file__), "lora_modules_loaded": lora_modules,
        "prefill_step_size": runtime["prefill_step_size"], "cache_limit_bytes": runtime["cache_limit_bytes"],
        "context_limit_tokens": runtime["context_limit_tokens"], "enable_thinking": runtime["enable_thinking"],
        "system_prefix_cache": runtime["system_prefix_cache"], "trust_remote_code": runtime["trust_remote_code"],
        "add_generation_prompt": runtime["add_generation_prompt"],"generation_temperature":runtime["temperature"],
        "generation_top_p":runtime["top_p"],"generation_seed":runtime["seed"],"model_max_tokens":runtime["max_tokens"],
        "python_isolated":bool(sys.flags.isolated),"python_no_user_site":bool(sys.flags.no_user_site),
        "python_ignore_environment":bool(sys.flags.ignore_environment),"python_safe_path":bool(sys.flags.safe_path),
        "python_dont_write_bytecode":bool(sys.flags.dont_write_bytecode),
        "cache_helper_sha256": digest(Path(__file__).with_name("pinned_prompt_cache.py")),
        "base_model_directory_manifest_sha256":runtime["base_model_directory_manifest_sha256"],
        "base_model_directory_sha256":runtime["base_model_directory_sha256"],
    }
    emit({"type": "ready", "identity": identity})
    prefix_cache = SystemPrefixCache()
    def build_prefix(tokens):
        cache = make_prompt_cache(model)
        for start in range(0, len(tokens), runtime["prefill_step_size"]):
            model(mx.array([tokens[start:start + runtime["prefill_step_size"]]]), cache=cache)
            mx.eval([entry.state for entry in cache])
        return cache
    for line in sys.stdin:
        request = json.loads(line)
        request_cache = response = parts = prompt = None
        try:
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                prompt = tokenizer.apply_chat_template(request["messages"], tokenize=True,
                                                       add_generation_prompt=runtime["add_generation_prompt"], enable_thinking=runtime["enable_thinking"])
                if len(prompt) + request["max_tokens"] > runtime["context_limit_tokens"]:
                    raise ValueError("Prompt exceeds pinned context limit")
                full_prompt_tokens = len(prompt)
                prompt, request_cache, cached_tokens = prefix_cache.prepare(request["messages"], prompt, tokenizer, build_prefix)
                mx.random.seed(request.get("seed", runtime["seed"]))
                parts = []
                for response in stream_generate(
                    model, tokenizer, prompt, max_tokens=request["max_tokens"],
                    sampler=make_sampler(temp=request.get("temperature", runtime["temperature"]), top_p=request.get("top_p", runtime["top_p"])),
                    prefill_step_size=runtime["prefill_step_size"],
                    prompt_cache=request_cache,
                ):
                    parts.append(response.text)
            emit({"type": "result", "id": request["id"], "content": "".join(parts),
                  "finish_reason": response.finish_reason,
                  "usage": {"prompt_tokens": full_prompt_tokens,
                            "completion_tokens": response.generation_tokens,
                            "total_tokens": full_prompt_tokens + response.generation_tokens},
                  "metrics": {"prompt_tps": response.prompt_tps,
                              "generation_tps": response.generation_tps,
                              "peak_memory_gb": response.peak_memory,
                              "system_prefix_tokens": cached_tokens,
                              "elapsed_seconds": time.perf_counter() - started}})
        except Exception as error:
            emit({"type": "error", "id": request["id"], "message": str(error)})
        finally:
            # Retain only the immutable system-prefix cache between requests.
            # Clear the allocator after releasing user-specific KV state.
            request_cache = response = parts = prompt = None
            mx.clear_cache()


if __name__ == "__main__":
    main()
