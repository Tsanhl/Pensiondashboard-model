# Owner-selected review route: AI

On 5 September 2026 the owner explicitly chose AI review in this conversation: “now me choose AI”. This records a review-method choice, not a passed evaluation or permission for unseen, training or release.

| Owner option | Review method | Current status |
|---|---|---|
| AI | Two isolated Codex reviewers evaluate the exact served answer and pinned evidence. Deterministic checks remain mandatory. | **Selected.** The automatic controller uses this route; runtime verification and live reviewer calibration are still required. |
| Human | Identified human reviewers examine the same answer, evidence, rubric and hard gates, with recorded, verifiable review receipts. | Alternative for a later explicit owner choice. Human-receipt ingestion into this controller has not been implemented or qualified; changing a config string cannot manufacture a human PASS. |

There is no automatic fallback between routes. Neither route implies external professional legal qualification; that requires independently verified reviewer credentials and the appropriate review scope.

For the selected AI route, every passing answer must have:

- Exact served-answer and evidence identity verified.
- Deterministic checks passed.
- Both reviewers independently returning PASS and scoring at least 70 each; no averaging away a failed reviewer.
- Every material claim linked to permitted, dated evidence, with required completeness and no material factual, citation, jurisdiction, safety, outcome or personal-fact failure.
- Preserved raw output, reviewer rationale, claim mappings and hash-bound execution receipts.

Unsupported claims, missing evidence, invalid review output and reviewer disagreement do not pass. Each reviewer must pass the finite calibration protocol individually, including correct acceptance of supported controls and correct rejection of deliberate errors. Missing or duplicate cases and unresolved HOLDs fail calibration. Calibration uses synthetic development material, never protected qualification or unseen cases.

“100% no illusion and accuracy” is implemented as a strict acceptance rule: no detected material unsupported or incorrect claim may pass, and every required evidence check must be satisfied. It is **not a guarantee that AI or human review can never miss an error**. Permitted reporting is limited to tested cases against pinned evidence, with limitations disclosed.

The latest recorded run, `post-t4-20260905071509-eb857ef9`, stopped during runtime startup with two sandboxed Node `SIGABRT` failures inside `node::InitializeOncePerProcessInternal`. It was not waiting for a human reviewer. The AI route was already configured; this owner selection makes that choice explicit. No calibration or pension evaluation case was consumed.

This selection does not edit historical status/gate artifacts, enable automatic repair, launch another training run, authorize sealed unseen, or authorize a live release. The next executable gate remains VERIFY_RUNTIME, followed by calibration, the ordered development/visible suites and freeze. A configuration change requires fresh evidence for the new candidate configuration.

## Verification of this change

The owner selection is pinned in `config/qualification-worker.json` and included in `qualification:plan` and new run state. Historical runs without a selection field are labelled as such, rather than retrospectively assigned a reviewer identity.

The calibration validator now checks both raw reviewer verdicts independently. It rejects an individual false approval even when the combined verdict rejects the case, a false rejection, a supported control below the score floor, missing hard gates, incorrect case identity, duplicate/missing cases and unresolved HOLD/PARTIAL verdicts. These checks supplement the existing hash-bound review receipts and claim mapping validation.

Current local verification on 5 September 2026:

- 77 focused harness tests passed with zero failures/skips, including reviewer calibration, isolation, signed reliability requests, per-topic qualification scoring, launchd lifecycle and worker integrity tests.
- A clean public snapshot completed `npm ci`, 121 application passes with two declared skips, and 18 qualification-worker passes.
- `node scripts/qualificationWorker.mjs --plan` completed and reports the owner-selected AI route, unchanged stage order and restricted permissions.
- Static preflight passed all 41 pinned inputs.
- Canonical configuration digest: `d3dbdcda2aebab12d856b66add9a3460f6917868e23c283b1aa74e3f7d27f4b9`.
- Runtime configuration digest remains `a2cbf2090d7d09ef5a659ef537e593f3b9656c5531f3e4dff7b7a16b3eaef0b2`.

No live AI calibration, pension evaluation, unseen access or live release has occurred. The runtime startup blocker must be resolved in a new bounded repair before the ordered route can continue.
