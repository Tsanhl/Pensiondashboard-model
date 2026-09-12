# Authorized adaptability work — 8 September 2026

## Current receipt-backed state — 9 September 2026

The [owner execution contract](../OWNER-EXECUTION-CONTRACT.md) governs resumption. Full-model main training is **NOT_STARTED, 0/48 updates**. No new adapter is selected. The old run-v2 one-update smoke was interrupted by the 8 September reset after validation, without a confirmed update or exit receipt. The old runner's code bytes were archived privately before today's changes; its old binding is not silently refreshed.

Two explicitly budgeted disposable diagnostics have now ended under the host swap-growth guard, both during gradient evaluation with zero updates. The first uses the pinned default loss without whole-step compilation; the second uses corrected, target-only vocabulary projection, again without whole-step compilation. Removing compilation did not prevent observed host pressure. The second forward peak was 5.835 GB versus 6.893 GB in the first, but neither completed gradients; these are not full-training peak measurements or proof that the host cannot train under any configuration. Swap baseline differed between attempts and must not be omitted from comparisons. The guard was a conservative diagnostic limit of 2,048 MB growth, not physical memory exhaustion. No global memory settings or unrelated applications were changed.

Pinned `mlx-lm 0.31.3` computes the original mask with `position <= total_length`, thereby including one padding token. The corrected implementation uses `< total_length`; all reviewed answer tokens and the complete input context remain included. `ml/assistant_target_loss.py` runs the full Qwen3 transformer and projects only the final 128 positions through the vocabulary head. Every row is checked to ensure no supervised position is omitted. Synthetic CPU tests compare loss, all parameter gradients and two compiled Adam updates against a full-logit corrected reference for tied and untied heads. Those tests pass; they are not an 8B runtime proof. An earlier uninstrumented synthetic optimiser check was stopped without completion; the subsequent bounded instrumented check completed in 6.65 seconds. Both receipts are retained; do not retrospectively mark the first pass.

`ml/train_adaptability.py` now requires the explicit corrected-loss execution binding, verifies exact parent trainable weights, and applies the same loss when reloading/selecting saved checkpoints. `runAdaptabilityTraining.mjs` refuses main execution without a matching completed two-update/longest-row/save-reload proof. The preparation script creates an unproven plan with no runtime receipt; preparing it is not execution permission. The current compiled main implementation has no successful full-model proof. Do not bypass the guard or treat the eager diagnostic as compiled acceptance.

### Dataset revision and independent review

The original reviewed v2 24/8 bytes remain intact. Audit found zero history examples and zero multi-source examples. V3 revised seven existing training rows to add matched changed facts, prior conversation, distracting document instructions, stale-versus-newer confirmed records, and removal of a redundant question. It retained all eight validation rows exactly. V3 review: A32 PASS; B31 PASS/1 HOLD. B identified an unsupported assumption that a verified provider submission process exists in an older read-only target.

V4 corrects that single additional target by saying an authorised route must first be identified. Both isolated reviewers now return **32 PASS**, and immutable receipts were independently revalidated. This approves data only. The final set remains 24 training/8 validation, with three history-bearing training rows, two multi-source rows, maximum total 3,292 tokens and maximum completion77. The longest example is unchanged from the disposable diagnostics; all answer tokens fit the checked loss window. Validation remains development selection data, not final unseen evidence.

Private root: `/Users/hltsang/.codex/private/pension-adaptability/20260909/`.

| Artifact | SHA-256 |
| --- | --- |
| `dataset-v4/train.jsonl` | `85d114fc659a7eea40e8706261c2981e058ca6b793b72725957153053822dd58` |
| `dataset-v4/valid.jsonl` | `ce702af64cd487a6189c595536d3255e8ce1957a2fa4390b217f8fb543bd6504` |
| `dataset-v4/review-packet.json` | `14cd3c0b2744e36e53c05370dc270842c4b0bc091ac129d431ffd7354549bcb3` |
| `review-v4/training-data-review.json` | `83cc3f262b20b4cdb968074edac9e801cc225ab1552ecff9dccb3a142d3bf49c` |

### Exact next training operation — not yet permitted by runtime proof

The two-full-model diagnostic budget is exhausted. A further attempt needs a new declared finite diagnostic/resource proposal, not an automatic third launch. Its concrete objective is two completed longest-example updates plus save/reload using the corrected loss and the same compiled execution intended for main training, recording in-flight physical footprint/device allocation and swap baseline/delta. It must explain the previous guard crossings and bind the exact v4 data, unchanged104/base, code, optimizer and resource settings. Do not increase the 48 main updates, substitute model/LoRA architecture, shorten evidence/targets, purchase compute or stop other applications to force it through. If the configuration changes materially, obtain any required approval and exact new binding. Only a successful matching proof may unblock the existing 48-update experiment.

The actual baseline product has been restarted for browser diagnosis with its known legal-answer limitations. Latest browser and service status belong in STATUS and the main repair report. Formal qualification and sealed unseen remain unexecuted under this continuation.

---

The following is retained historical context from 8 September, not today's completion receipt.

The latest owner message authorizes further evaluation and training before another live owner test. This supersedes the previous continuation's no-training restriction for this work. It does not turn historical failures into passes or authorize deployment, publishing, iteration 312, or opening the existing sealed bank. Checkpoint 104 and its source receipts remain immutable.

## Observed training gap

A metadata/statistical audit of the exact 104 training rows found no question marks in any completion, and an average of approximately 56 words excluding citations. Inputs used JSON question/evidence objects and short system instructions. Production uses a longer policy and a labelled source pack. This establishes a distribution gap, not proof that the model cannot generalize. A controlled JSON-input experiment against checkpoint 104 still failed with an uncited and overbroad answer.

The new draft contains 24 training and eight validation examples. Public law examples use the already independently admitted source excerpts. Invented scheme records explicitly remain fictional and cannot establish law. Training and validation are disjoint by source identity, source text, source family and scenario construct. No historical completion or protected evaluation bank is imported into the new builder.

The training policy is to continue from the exact selected checkpoint-104 adapter into a fresh output directory, retain the same pinned base/runtime, use completion-only loss with the exact non-thinking serving prefix, run a quarantined longest-example memory smoke, then a finite 48-step run. Checkpoints are saved and validated every 12 steps, selecting the lowest validation loss, ties preferring the earlier checkpoint. Validation loss is only candidate selection evidence; actual generated answers and real browser journeys must pass before formal qualification.

The raw draft and reviews are private under `/Users/hltsang/.codex/private/pension-adaptability/20260908/`. Each dataset revision and review remains separate. No model may train until both existing isolated reviewers approve the exact packet and their receipts are revalidated.

## Evaluation separation

- Training: new reviewed behavior examples only.
- Development validation: eight source/construct-disjoint examples used for loss-based selection; these are not called unseen qualification.
- Additional development generation: six fixed, newly authored scenarios outside both partitions, plus the owner browser cases. Implementer-visible and not sealed.
- Formal visible stages: the existing controller order, hard gates, reviewers, signatures and first-failure stop remain required for a new candidate.
- Sealed unseen: the existing bank remains closed. A genuinely new unseen bank, if needed after exposure, must be constructed and retained by a separate custodian. The implementing agent must not generate and inspect its answers and then call it unseen.

A future unseen run must bind the frozen source, corpus, model, configuration and reviewer identities. It requires separate owner authorization after visible qualification and freeze. No post-freeze edits may reuse the approval; no exposed failure may be trained and then rerun as unseen.

## Status

Independent data review and baseline generation checks are in progress. Training has not started. The live product remains development-only; Q1 was not fixed by the format experiment. The owner should not yet treat this as ready for the requested acceptance test.

## Checkpoint-selection defect found during this audit

The installed MLX-LM 0.31.3 training loop evaluates validation before an iteration update and reports the actual completed-update index as `iteration - 1` through its callback. It saves the labelled checkpoint after the update. The old cumulative selector joins the printed iteration number directly to the checkpoint filename. The checkpoint-104 manifest contains those rounded printed losses and no exact post-hoc evaluation field; a separate post-hoc script in the repository is scoped to an older, different failed run.

This is an off-by-one evidence-binding defect in the selection procedure, not proof that checkpoint 104 would fail or that another historical checkpoint should be substituted. Historical artifacts are preserved. The new runner explicitly reloads each saved step-12/24/36/48 adapter, evaluates the full validation partition, and records full-precision loss with the exact adapter hash before selection. Baseline loss uses the pre-update callback at completed step zero.
