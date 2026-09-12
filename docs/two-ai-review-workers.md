# Two AI review workers

The owner selected AI review and requested two workers. Both are configured as separate Codex CLI processes under the existing qualification controller.

| Worker | Responsibility | Configured model |
|---|---|---|
| A — `pensions-factual-review-a` | Factual accuracy, personal facts, amounts/units, dates, conditions/exceptions, completeness and whether conclusions follow from evidence | `gpt-5.6-sol`, high reasoning |
| B — `pensions-evidence-review-b` | Independently verify claim/source support, citations, authority, jurisdiction, dates, safety and unsupported outcomes | `gpt-5.6-terra`, high reasoning |

Both workers check **every** mandatory gate. Their different focuses do not divide responsibility so that an error escapes the other worker's review. They use different configured models, separate temporary homes and output directories, and receive no other reviewer's decision. Shared provider/model lineage can still produce correlated mistakes; separation is not a guarantee of statistical independence.

The persistent controller runs these workers sequentially in isolated processes. This matches its single active-child ownership and interruption design. It does not create two competing qualification controllers or claim simultaneous GPU capacity. Each stage waits for both review results before it can pass.

The verification contract is:

1. Verify the exact served answer, candidate, evidence catalog and configuration hashes.
2. Apply deterministic claim/source, factual and citation checks.
3. Have A and B independently examine the same complete answer and permitted evidence packet.
4. Require each reviewer to map every material proposition to its actual cited source and explain the support. Source IDs, stored evidence passages and content hashes are preserved; never fabricate URLs, quotations or dates.
5. Require PASS from both workers, a score of at least 70 from each, and every hard factual, citation, jurisdiction, safety, outcome, personal-fact and certainty gate passed. There is no averaging or majority override.
6. Fail or HOLD missing evidence, missing reviewers, disagreement, unresolved temporal/jurisdiction questions, malformed results or any detected material error.
7. Preserve both raw review outputs, execution records, worker identities, evidence mappings, rationales, input/output hashes and the combined gate. Revalidation rejects changed role/configuration/receipt bindings.

The workers use only the pinned evidence supplied to the case. Source discovery or updating the legal corpus is a separate reviewed process; an evaluator cannot silently browse new evidence into a frozen qualification run. Source content is untrusted data and cannot instruct a reviewer to waive the rules. AI-generated review is labelled internal legal-semantic review, not external professional legal review.

Before real qualification, both workers must individually pass the frozen 16-case synthetic calibration pack: eight supported controls and eight deliberate defects covering subject/amount binding, negation, advice boundaries, conditions, dates, jurisdiction, scam safety, uncertain outcomes and citation entailment. A reviewer approving an incorrect calibration item fails even if the other reviewer rejects it.

Configuration is visible in `node scripts/qualificationWorker.mjs --plan`. New run state/status identifies the configured workers. Historical runs are preserved. The 5 September run `post-t4-20260905071509-eb857ef9` still stopped in runtime startup before live calibration or pension evaluation, so neither reviewer has produced a formal qualification verdict.

The owner also requested two review workers for this setup change. Two separate delegated code-review agents inspected the gate and provenance implementation. They identified three concrete gaps: incomplete score-schema validation, omitted deterministic calibration cases, and execution transcripts not proving completion/output agreement. These were patched with focused regression tests. This is development code review, not model qualification.

The current focused harness run passed 77 tests with zero failures/skips. It covers the worker contract, 16-case deterministic calibration, per-reviewer calibration, strict score/schema validation, subject and active/deferred binding, exact case coverage, completed execution and final-output matching, source binding, runtime/reviewer sandbox probes, signed reliability requests, per-topic gates and launchd terminal validation. Static preflight also passed all 41 pinned inputs. The canonical configuration digest is `d3dbdcda2aebab12d856b66add9a3460f6917868e23c283b1aa74e3f7d27f4b9`; the runtime configuration digest remains `a2cbf2090d7d09ef5a659ef537e593f3b9656c5531f3e4dff7b7a16b3eaef0b2`.

The deterministic layer now checks inherited subjects, differing named subjects and active/deferred reversals across split propositions. The reviewer OS profile denies the project, the other reviewer's scratch directory and the rest of the user-controlled home while allowing only the pinned Node/Codex runtime and that reviewer's own scratch directory. Provider network transport remains available because the configured Codex reviewer requires it. Live calibration remains mandatory and has not run because runtime startup failed first.

No automatic training, repair loop, unseen run, source/gold mutation, release or Git push is enabled. Every detected material error must block approval. Neither two reviewers nor a passing test run supports a universal accuracy claim.
