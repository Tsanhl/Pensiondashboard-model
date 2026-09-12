# Pension Plan dashboard and grounded local assistant

The dashboard keeps its existing visual design and deterministic projection calculations. The assistant backend is now a read-only, self-hosted pipeline:

`API gateway → Chat Service → Conversation Store → Query Processor → structured/RAG retrieval → Qwen3-8B → Grounding Validator → audit/handoff`

There are no OpenAI, Gemini, Groq, OpenRouter, custom-provider, browser API-key, or canned pension-answer paths. `Qwen3-8B` is the sole answer model. Current facts belong in Postgres/RAG, not in the LoRA adapter.

## Run locally

Requirements: Node 22+, Docker Desktop, and either Ollama or `llama-server`.

```bash
npm install
cp .env.example .env
npm run infra:up
npm run setup:models -- --dry-run
npm run setup:models
npm run setup:runtime
npm run model:serve
npm start
```

`setup:models` downloads the pinned official `Qwen/Qwen3-8B-GGUF` Q4_K_M artifact (about 5 GB) and verifies its exact byte size and SHA-256 checksum. `setup:runtime` installs a pinned, checksum-verified official llama.cpp binary for Apple Silicon, Intel macOS, or Windows without changing system packages. The default local endpoint is `http://127.0.0.1:8080`. To use Ollama instead, set `MODEL_RUNTIME=ollama`, `LOCAL_LLM_TRANSPORT=ollama`, `LOCAL_LLM_BASE_URL=http://127.0.0.1:11434`, and `LOCAL_LLM_MODEL=qwen3:8b`.

The local English embedding service is optional during UI development; without it, the backend labels and uses a deterministic test-only 384-dimensional fallback. Production must set `ALLOW_DEGRADED_EMBEDDINGS=false` and run:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r ml/requirements-embedding.txt
npm run setup:retrieval-models
npm run retrieval:serve
```

The retrieval-model service exposes the exact BGE embedding and cross-encoder revisions pinned in `models/model-manifest.json` on port 8090. Provision them explicitly with `npm run setup:retrieval-models`; runtime loading is local-files-only and fails closed if either immutable snapshot, the model manifest, or the retrieval-server source identity differs. With `REQUIRE_CROSS_ENCODER_RERANK=true`, retrieval also fails closed if the pinned reranker is unavailable; local UI development may use the labelled deterministic fallback only outside qualification and release runs.

`npm run dev:full` starts infrastructure, the model command, and the app. `SKIP_LOCAL_MODEL=true npm run dev:full` skips the model command.

## Local demo and release readiness

For UI-only local work, keep `REQUIRE_AUTH=false`; the demo profile and `X-Demo-User-Id` continue to work. `GET /api/status` is an informational liveness response and may remain `200` while optional local dependencies are absent. `GET /api/ready` is deliberately stricter and returns `503` until every release dependency is usable: both model hashes are pinned and the runtime identity matches, embedding and cross-encoder probes succeed, the datastore/cache/object store are live, the required malware scanner is healthy, and the pinned approved corpus is active.

An approved-corpus bootstrap is opt-in and idempotent. Set `APPROVED_CORPUS_MANIFEST_PATH` to a JSON manifest, pin its exact bytes in `APPROVED_CORPUS_MANIFEST_SHA256`, then run:

```bash
shasum -a 256 /absolute/path/to/approved-corpus/manifest.json
APPROVED_CORPUS_MANIFEST_PATH=/absolute/path/to/approved-corpus/manifest.json \
APPROVED_CORPUS_MANIFEST_SHA256=<64-hex-digest> \
npm run materials:bootstrap-approved-corpus
```

The manifest uses `schema_version: 1`, top-level `approval_status`, `approved_by`, `approved_at` and `documents`. Each document requires `id`, `title`, `authority`, `jurisdiction`, `canonical_location`, positive integer `version`, `effective_date`, `licence`, `reviewer`, `approval_status: "approved"`, `source_type`, a manifest-relative `text_path`, and the text file's `text_sha256`. Text paths cannot escape the manifest directory. Existing versions with a different checksum are rejected rather than overwritten. Setting `APPROVED_CORPUS_BOOTSTRAP_ON_START=true` performs the same guarded bootstrap before serving; keep it false when bootstrapping in a separate release step.

For production, also set `REQUIRE_AUTH=true`, `REQUIRE_2FA=true`, `ALLOW_DEGRADED_EMBEDDINGS=false`, `REQUIRE_CROSS_ENCODER_RERANK=true`, `PENSIONS_STORAGE=postgres`, `OBJECT_STORAGE_MODE=s3`, and `REQUIRE_MALWARE_SCAN=true`. Configure independent `EMBEDDING_SERVICE_URL` and `RERANK_SERVICE_URL` values even when both routes are hosted by the same external service. The deployment health check must target `/api/ready`, not `/api/status`.

## Pinned adapter evaluation (Wave 4)

`npm run model:serve:pinned` runs the selected Wave 3 MLX adapter with artifact-hash checks, single-request serving and worker cancellation on timeout/disconnect. This is a local evaluation runtime, not a production deployment. The default `model:serve` command above remains **base-only**; its results must not be labelled as adapter results. See [Wave 4 repair and reproduction instructions](training/evaluation-cycle-v2/03-wave-4-release-gate/RUNTIME-REPAIR.md).

## Public chat contract

`POST /chat`

```json
{
  "session_id": "optional-existing-session",
  "client_request_id": "required-idempotency-key",
  "message": "Can I still transfer the OneLife pension?"
}
```

The user ID comes from the authenticated server session. `X-Demo-User-Id` is accepted only while `REQUIRE_AUTH=false` for local demo profiles.

```json
{
  "session_id": "chat_123",
  "message_id": "msg_456",
  "response": "Grounded answer [source_1]",
  "sources": [{ "source_id": "source_1", "title": "Policy", "section": "Transfer", "snippet": "Evidence", "effective_date": "2026-05-01" }],
  "confidence": "grounded",
  "handoff": null
}
```

WebSocket clients connect to `/ws/chat`. Supported events are `chat.start`, `chat.accepted`, `chat.status`, `chat.delta`, `chat.sources`, `chat.completed`, `chat.cancel`, `chat.resume`, and `chat.error`. Deltas are sequenced, sessions are persisted before generation, and the server sends 30-second ping/pong heartbeats. Never put tokens, user IDs, or financial information in the WebSocket URL.

Conversation endpoints:

- `GET /api/conversations`
- `GET /api/conversations/:sessionId`
- `DELETE /api/conversations/:sessionId`

The Conversation Store retains the complete 30-day server-side transcript. Query processing uses a sliding window of the latest 20 messages (about 10 turns), a compact summary of older messages, and only provider/policy entities that appeared in authenticated data or conversation history. Ordinal and pronoun follow-ups such as “the first one” and “what about it?” are rewritten into self-contained retrieval queries.

## Document memory

1. `POST /api/documents/upload-intents` with filename, MIME type, and size.
2. Upload bytes to the returned short-lived URL.
3. `POST /api/documents/:id/complete` with the SHA-256 checksum and source metadata.
4. The ingestion path validates the signature/type boundary, extracts readable text, saves immutable normalized text, extracts unconfirmed facts, structurally chunks the material, creates BGE embeddings, validates the result, and activates the new searchable version.

Originals and normalized text live in encrypted S3-compatible object storage (local filesystem mode is for development). Postgres stores metadata, unconfirmed facts, sections, chunks, 384-dimensional pgvector embeddings, conversations, citations, and audit records. Redis stores only short-lived hot state and retrieval results. Cache keys contain user, corpus version, query hash, scopes, and retrieval configuration.

## Retrieval, logging, and freshness

The Retrieval Service uses the validated intent to query the authenticated structured Info DB, private user chunks, approved public chunks, or a hybrid of those sources. Unstructured candidates use vector plus keyword search and cross-encoder reranking before the relevance threshold is applied. Expired chunks and quarantined prompt-injection content are removed before the model can see them.

Redacted diagnostic JSONL is written to `Logging/YYYY-MM-DD/` in four streams: `retrieval-quality`, `grounding-failures`, `fallbacks`, and `freshness`. Raw questions, source snippets, secrets, and user IDs are excluded by default; set `DEBUG_LOG_INCLUDE_TEXT=true` only in an access-controlled development environment.

Approved CMS/source updates can call `POST /api/materials/change-events` with `X-Material-Webhook-Secret`. Events enter the durable worker queue and support `UPSERT` and `DELETE`. Every UPSERT requires source authority, jurisdiction, canonical location, version and licence metadata. New chunks are activated atomically, retrieval cache keys include the corpus version, and `expires_at` is enforced at query time. `GET /api/materials/freshness` reports stale/expired documents and the daily no-result rate.

Local corpus preparation is repeatable through the `materials:*` commands in `package.json`, including legislation, secondary legislation, UK/EU case law, regulatory codes and curated case summaries. Official originals and normalized index inputs are deliberately separated under `approved-materials/`. The current Seminar 1–6 coverage and source-rights audit is recorded in `approved-materials/index/seminar-knowledge-gap-report.md`. Seminar notes are topic maps only, never active evidence. The 52-file local case inventory has been reconciled: reusable official judgments or explicitly labelled curated summaries are active, while every local seminar copy remains inactive.

Supported extraction is PDF, DOCX, TXT, CSV, and JSON. Image upload is accepted but fails closed until an OCR worker is configured. Facts from any upload remain `Review` until the existing confirmation endpoint is used; they cannot alter projections before confirmation.

## Material admission rules

Index only:

- current approved UK legislation and GOV.UK pension material;
- The Pensions Regulator, FCA, HMRC, Pensions Ombudsman, and MoneyHelper guidance;
- administrator-approved provider and scheme documents; and
- authenticated user pension statements, policies, notices, and forecasts.

Every public or administrator-managed source must have a title, authority, jurisdiction, canonical location, version, publication/effective/expiry dates, SHA-256 checksum, licence, reviewer, and ingestion status. Expired or superseded sources must not be active. Legal updates trigger re-indexing.

Chunking is structure-first: one FAQ pair per chunk; clause/list/table-aware policy sections; and law `part → section → subsection`, with semantic subdivision only beyond 900 tokens. Targets are 600–900 tokens with about 100 tokens of overlap inside the same section.

## Fine-tuning rules

Fine-tune behaviour only: answer format, use of evidence, citation discipline, clarification, conflict/staleness handling, prompt-injection resistance, read-only boundaries, and handoff. Do not train current legal thresholds, provider facts, or user data into weights.

Each English JSONL example needs stable evidence IDs, citations, expected handoff, source family/topic, and approved pension-domain review. Legal or tax claims also require legal/compliance review. Split by source family and topic—not random rows. Exclude real users, private documents, balances, policy numbers, secrets, current thresholds, unlicensed content, and unreviewed generated answers.

```bash
npm run training:validate -- training/examples.sample.jsonl
# Mac experiment (install mlx-lm first)
bash training/train_mlx.sh /path/to/mlx-dataset
# NVIDIA canonical PEFT adapter
PENSION_TRAINING_JSONL=/private/path/train.jsonl python training/train_cuda.py
```

Adapters and private datasets are ignored by Git. Publish an adapter only with its model/base revision, dataset manifest, reviewer approvals, held-out results, and checksum.

## Safety and testing

The model sees only verified structured facts and retrieved evidence. Citation IDs are checked against supplied context. Figures, dates, percentages, charges, policy identifiers, guarantees, deadlines, and legal/tax claims need exact support. Missing, weak, stale, or conflicting evidence fails closed to one of three safety outcomes: model unavailable, insufficient verified evidence, or human handoff. The assistant cannot transfer money, change contributions, submit forms, update balances, or contact providers.

```bash
npm run check
npm test
npm run visual:check
# Private held-out corpora/results:
npm run eval:retrieval -- /private/path/retrieval.jsonl
npm run eval:answers -- /private/path/answers.jsonl
```

Production acceptance gates are retrieval recall@8 ≥85%, answer/citation format compliance ≥95%, no invented citation IDs, no critical unsupported financial/legal claims, zero cross-user retrieval/cache leakage, and successful Q4 execution on the 16 GB M2 baseline.
