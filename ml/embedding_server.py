from fastapi import FastAPI
import hashlib
import json
import os
from pathlib import Path
import sys
from threading import Lock
import torch
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field
from sentence_transformers import CrossEncoder, SentenceTransformer

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_MANIFEST_PATH = PROJECT_ROOT / "models" / "model-manifest.json"
MODEL_MANIFEST_BYTES = MODEL_MANIFEST_PATH.read_bytes()
MODEL_MANIFEST_SHA256 = hashlib.sha256(MODEL_MANIFEST_BYTES).hexdigest()
MODEL_MANIFEST = json.loads(MODEL_MANIFEST_BYTES)
MODEL_NAME = MODEL_MANIFEST["embedding_model"]["repository"]
MODEL_REVISION = MODEL_MANIFEST["embedding_model"]["revision"]
RERANK_MODEL_NAME = MODEL_MANIFEST["reranker_model"]["repository"]
RERANK_MODEL_REVISION = MODEL_MANIFEST["reranker_model"]["revision"]
SERVER_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
if MODEL_MANIFEST["retrieval_runtime"]["embedding_server_sha256"] != SERVER_SHA256:
    raise RuntimeError("Pinned embedding-server source hash does not match models/model-manifest.json")
if MODEL_MANIFEST["retrieval_runtime"].get("local_files_only") is not True:
    raise RuntimeError("Pinned retrieval models must run local-files-only")
EMBEDDING_SNAPSHOT = snapshot_download(repo_id=MODEL_NAME, revision=MODEL_REVISION, local_files_only=True)
RERANK_SNAPSHOT = snapshot_download(repo_id=RERANK_MODEL_NAME, revision=RERANK_MODEL_REVISION, local_files_only=True)
# Reserve Metal for the answer model on unified-memory Macs. Serialize retrieval
# inference so concurrent FastAPI threads cannot multiply the memory footprint.
DEVICE = os.environ.get("PENSION_RETRIEVAL_DEVICE", "cpu")
torch.set_num_threads(max(1, int(os.environ.get("PENSION_RETRIEVAL_THREADS", "2"))))
inference_lock = Lock()
model = None
reranker = None
app = FastAPI(title="Pension BGE embedding service")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=128)
    model: str = MODEL_NAME
    normalize: bool = True


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=6000)
    documents: list[str] = Field(min_length=1, max_length=64)
    model: str = RERANK_MODEL_NAME
    top_n: int = Field(default=8, ge=1, le=64)


@app.get("/health")
def health():
    return {
        "ok": True, "model": MODEL_NAME, "model_revision": MODEL_REVISION,
        "dimensions": 384, "reranker_model": RERANK_MODEL_NAME,
        "reranker_revision": RERANK_MODEL_REVISION, "server_sha256": SERVER_SHA256,
        "model_manifest_sha256": MODEL_MANIFEST_SHA256, "local_files_only": True,
        "embedding_loaded": model is not None, "reranker_loaded": reranker is not None,
        "device": DEVICE, "threads": torch.get_num_threads(),
    }


@app.post("/embed")
def embed(request: EmbedRequest):
    global model
    if request.model != MODEL_NAME:
        return {"error": "Only BAAI/bge-small-en-v1.5 is supported."}
    with inference_lock:
        if model is None:
            model = SentenceTransformer(EMBEDDING_SNAPSHOT, device=DEVICE, local_files_only=True)
        vectors = model.encode(request.texts, normalize_embeddings=request.normalize)
    return {
        "model": MODEL_NAME, "model_revision": MODEL_REVISION,
        "server_sha256": SERVER_SHA256, "model_manifest_sha256": MODEL_MANIFEST_SHA256,
        "embeddings": vectors.tolist(),
    }


@app.post("/rerank")
def rerank(request: RerankRequest):
    global reranker
    if request.model != RERANK_MODEL_NAME:
        return {"error": "Only BAAI/bge-reranker-base is supported."}
    with inference_lock:
        if reranker is None:
            reranker = CrossEncoder(RERANK_SNAPSHOT, device=DEVICE, local_files_only=True)
        scores = reranker.predict([(request.query, document) for document in request.documents])
    ranked = sorted(
        [{"index": index, "score": float(score)} for index, score in enumerate(scores)],
        key=lambda item: item["score"], reverse=True
    )[:request.top_n]
    return {
        "model": RERANK_MODEL_NAME, "model_revision": RERANK_MODEL_REVISION,
        "server_sha256": SERVER_SHA256, "model_manifest_sha256": MODEL_MANIFEST_SHA256,
        "results": ranked,
    }


if __name__ == "__main__" and "--identity-preflight" in sys.argv:
    print(json.dumps({
        "ok": True, "embedding_model": MODEL_NAME, "embedding_revision": MODEL_REVISION,
        "dimensions": 384,
        "reranker_model": RERANK_MODEL_NAME, "reranker_revision": RERANK_MODEL_REVISION,
        "server_sha256": SERVER_SHA256, "model_manifest_sha256": MODEL_MANIFEST_SHA256,
        "local_files_only": True,
        "embedding_snapshot_revision": Path(EMBEDDING_SNAPSHOT).name,
        "reranker_snapshot_revision": Path(RERANK_SNAPSHOT).name,
    }))
