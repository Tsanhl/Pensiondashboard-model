"""Explicitly provision the immutable retrieval-model revisions for local use."""

import json
from pathlib import Path

from huggingface_hub import snapshot_download


PROJECT_ROOT = Path(__file__).resolve().parent.parent
manifest = json.loads((PROJECT_ROOT / "models" / "model-manifest.json").read_text())
models = [manifest["embedding_model"], manifest["reranker_model"]]
resolved = []
for model in models:
    snapshot = Path(snapshot_download(repo_id=model["repository"], revision=model["revision"]))
    if snapshot.name != model["revision"]:
        raise RuntimeError(f"Resolved the wrong snapshot for {model['repository']}")
    resolved.append({"repository": model["repository"], "revision": model["revision"]})

print(json.dumps({"status": "pinned_retrieval_models_cached", "models": resolved}))
