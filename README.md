# Pensiondashboard-model

This is the current fail-closed source snapshot of the UK pensions dashboard and its post-T4 qualification controller.

**It is not a live-qualified model release.** T4 training completed and checkpoint 104 was selected. Five Live-50 Round-53 product-path regressions were repaired, but the clean post-repair evaluation has not started because static preflight found 161 replacement-topic rows with only 136 unique IDs. The sealed unseen set has not been opened or run.

## Current gate

| Item | Status |
| --- | --- |
| T4 training | Complete |
| Selected checkpoint | Iteration 104 |
| Product-path repair | Complete and regression-tested |
| Post-repair development evaluation | Not started |
| Visible qualification | Not started |
| Live-qualified release | No |
| Sealed unseen | Closed and not accessed |

The controller route is:

`VERIFY_RUNTIME → T4_TARGETED_REGRESSION → TOPIC161_ORIGINAL_DEVELOPMENT → LIVE50_FULL_REGRESSION → RELIABILITY_GATE → VISIBLE_CRITICAL4 → VISIBLE_FULL69 → VISIBLE_TOPIC161_REPLACEMENT_V2 → VISIBLE_FROZEN13 → CANDIDATE_FREEZE`

A score of 70 is a floor. Every factual, citation-entailment, jurisdiction, safety, outcome, and personal-fact gate must pass, together with two independent isolated Codex reviews. “Fact checked” means checked against the pinned evidence supplied for that run; it is not a claim of universal or error-free truth.

The worker records immutable raw response bytes, server signatures, runtime identities, sources, citations, attempts, retries, dual-review receipts, failure classifications, stage gates, and hash manifests. Training, legal-gold changes, sealed unseen, release, and Git push remain outside worker authority.

## Public snapshot boundary

Included: application source and tests, qualification-controller source, its machine-bound configuration, approved-corpus manifest metadata, and aggregate historical/current status evidence.

Excluded: model weights, adapters, raw corpus text, private training/evaluation inputs, databases, logs, credentials, sealed unseen questions, sealed unseen gold, and per-case unseen output.

The checked-in qualification configuration records the local candidate identity and fails closed on another machine until the omitted local artifacts and exact pinned dependencies are restored.

## Install and verify

```bash
npm install
cp .env.example .env
npm run check
npm test
npm run qualification:test
```

`npm run qualification:preflight` is expected to fail in this public snapshot because protected and machine-local candidate inputs are deliberately excluded. On the controlled owner machine it currently fails on the duplicate-ID blocker in `release-evidence/POST-T4-STATUS.json`.

Development serving is not a qualification pass:

```bash
npm run model:serve:pinned
npm run retrieval:serve
npm start
```

The assistant is read-only and provides information and routing support. It cannot transfer money, change contributions, submit forms, provide regulated financial advice, or replace a solicitor, regulated adviser, scheme administrator, HMRC, a regulator, or an ombudsman.
