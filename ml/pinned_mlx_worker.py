"""Single-request, explicitly pinned MLX worker. Protocol is JSON lines on stdio.

The parent owns deadlines and kills this process on disconnect, including during
Metal prefill (which cannot be reliably interrupted by a Python cancellation flag).
No request can select a different model or adapter. This is a local test runtime.
"""
import contextlib
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time
from pinned_prompt_cache import SystemPrefixCache


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def emit(payload):
    print(json.dumps(payload), flush=True)


def main():
    checkpoint_path = Path(sys.argv[1]).resolve()
    checkpoint = json.loads(checkpoint_path.read_text())
    training = json.loads((checkpoint_path.parent / "training-run-manifest.json").read_text())
    base = Path(training["base_model"]["path"]).resolve()
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

        mx.set_cache_limit(128 * 1024 * 1024)
        model, tokenizer = load(str(base), adapter_path=str(adapter),
                                tokenizer_config={"trust_remote_code": False})
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
        "prefill_step_size": 256, "cache_limit_bytes": 128 * 1024 * 1024,
        "context_limit_tokens": 8192, "enable_thinking": False,
        "system_prefix_cache": True, "cache_helper_sha256": digest(Path(__file__).with_name("pinned_prompt_cache.py")),
    }
    emit({"type": "ready", "identity": identity})
    prefix_cache = SystemPrefixCache()
    def build_prefix(tokens):
        cache = make_prompt_cache(model)
        for start in range(0, len(tokens), 256):
            model(mx.array([tokens[start:start + 256]]), cache=cache)
            mx.eval([entry.state for entry in cache])
        return cache
    for line in sys.stdin:
        request = json.loads(line)
        request_cache = response = parts = prompt = None
        try:
            started = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr):
                prompt = tokenizer.apply_chat_template(request["messages"], tokenize=True,
                                                       add_generation_prompt=True, enable_thinking=False)
                if len(prompt) + request["max_tokens"] > 8192:
                    raise ValueError("Prompt exceeds pinned context limit")
                full_prompt_tokens = len(prompt)
                prompt, request_cache, cached_tokens = prefix_cache.prepare(request["messages"], prompt, tokenizer, build_prefix)
                mx.random.seed(request.get("seed", 42))
                parts = []
                for response in stream_generate(
                    model, tokenizer, prompt, max_tokens=request["max_tokens"],
                    sampler=make_sampler(temp=request.get("temperature", 0), top_p=request.get("top_p", 1)),
                    prefill_step_size=256,
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
