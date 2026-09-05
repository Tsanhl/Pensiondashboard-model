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


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def directory_records(root):
    root = Path(root).resolve(strict=True)
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
                raise RuntimeError(f"Unsupported retrieval snapshot artifact: {path}")
    walk(root)
    return sorted(records,key=lambda value:value["path"])


SNAPSHOT_MANIFEST_PATH = PROJECT_ROOT / MODEL_MANIFEST["retrieval_runtime"]["snapshot_manifest_path"]
SNAPSHOT_MANIFEST_SHA256 = MODEL_MANIFEST["retrieval_runtime"]["snapshot_manifest_sha256"]
SNAPSHOT_CONTENTS_SHA256 = MODEL_MANIFEST["retrieval_runtime"]["snapshot_contents_sha256"]
if digest(SNAPSHOT_MANIFEST_PATH) != SNAPSHOT_MANIFEST_SHA256:
    raise RuntimeError("Pinned retrieval snapshot manifest hash mismatch")
SNAPSHOT_MANIFEST = json.loads(SNAPSHOT_MANIFEST_PATH.read_text())
EMBEDDING_SNAPSHOT = snapshot_download(repo_id=MODEL_NAME, revision=MODEL_REVISION, local_files_only=True)
RERANK_SNAPSHOT = snapshot_download(repo_id=RERANK_MODEL_NAME, revision=RERANK_MODEL_REVISION, local_files_only=True)
snapshot_rows = []
for name, repository, revision, actual_root in [
    ("embedding", MODEL_NAME, MODEL_REVISION, EMBEDDING_SNAPSHOT),
    ("reranker", RERANK_MODEL_NAME, RERANK_MODEL_REVISION, RERANK_SNAPSHOT),
]:
    expected = SNAPSHOT_MANIFEST.get("snapshots", {}).get(name, {})
    records = directory_records(actual_root)
    records_sha256 = canonical_hash(records)
    if expected.get("repository") != repository or expected.get("revision") != revision or Path(expected.get("root", "")).resolve() != Path(actual_root).resolve() or expected.get("records_sha256") != canonical_hash(expected.get("records", [])) or expected.get("records") != records or expected.get("records_sha256") != records_sha256:
        raise RuntimeError(f"Pinned {name} retrieval snapshot content mismatch")
    snapshot_rows.append({"name":name,"repository":repository,"revision":revision,"root":str(Path(actual_root).resolve()),"records_sha256":records_sha256})
if SNAPSHOT_MANIFEST.get("snapshot_contents_sha256") != canonical_hash(snapshot_rows) or SNAPSHOT_CONTENTS_SHA256 != canonical_hash(snapshot_rows):
    raise RuntimeError("Pinned retrieval snapshot combined digest mismatch")
# Reserve Metal for the answer model on unified-memory Macs. Serialize retrieval
# inference so concurrent FastAPI threads cannot multiply the memory footprint.
DEVICE = os.environ.get("PENSION_RETRIEVAL_DEVICE", "cpu")
torch.set_num_threads(max(1, int(os.environ.get("PENSION_RETRIEVAL_THREADS", "2"))))
RUNTIME_CONFIGURATION_SHA256 = os.environ.get("QUALIFICATION_RUNTIME_CONFIGURATION_SHA256")
PYTHON_ENVIRONMENT_SHA256 = os.environ.get("QUALIFICATION_PYTHON_ENVIRONMENT_SHA256")
if RUNTIME_CONFIGURATION_SHA256 and (os.environ.get("QUALIFICATION_RETRIEVAL_SNAPSHOT_MANIFEST_SHA256") != SNAPSHOT_MANIFEST_SHA256 or os.environ.get("QUALIFICATION_RETRIEVAL_SNAPSHOT_CONTENTS_SHA256") != SNAPSHOT_CONTENTS_SHA256):
    raise RuntimeError("Qualification retrieval snapshot binding mismatch")
PYTHON_STARTUP = {
    "python_isolated": bool(sys.flags.isolated),
    "python_no_user_site": bool(sys.flags.no_user_site),
    "python_ignore_environment": bool(sys.flags.ignore_environment),
    "python_safe_path": bool(sys.flags.safe_path),
    "python_dont_write_bytecode": bool(sys.flags.dont_write_bytecode),
}
if RUNTIME_CONFIGURATION_SHA256 and not all(PYTHON_STARTUP.values()):
    raise RuntimeError("Qualification retrieval runtime requires isolated Python startup")
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
        "runtime_configuration_sha256": RUNTIME_CONFIGURATION_SHA256,
        "python_environment_sha256": PYTHON_ENVIRONMENT_SHA256,
        "retrieval_snapshot_manifest_sha256":SNAPSHOT_MANIFEST_SHA256,
        "retrieval_snapshot_contents_sha256":SNAPSHOT_CONTENTS_SHA256,
        **PYTHON_STARTUP,
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
        "snapshot_manifest_sha256": SNAPSHOT_MANIFEST_SHA256,
        "snapshot_contents_sha256": SNAPSHOT_CONTENTS_SHA256,
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
        "snapshot_manifest_sha256": SNAPSHOT_MANIFEST_SHA256,
        "snapshot_contents_sha256": SNAPSHOT_CONTENTS_SHA256,
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
        "snapshot_manifest_sha256": SNAPSHOT_MANIFEST_SHA256,
        "snapshot_contents_sha256": SNAPSHOT_CONTENTS_SHA256,
    }))
