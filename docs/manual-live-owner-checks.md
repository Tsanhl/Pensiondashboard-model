# Owner manual live checks

## When to use this checklist

The current candidate is `BLOCKED_NOT_QUALIFIED` because the formal runtime did not start. It is not ready for a qualified live check.

You may use the dashboard for exploratory development checks after the runtime-startup defect is repaired, but label those checks `DEVELOPMENT_ONLY`. They do not replace the controller gates and must not use sealed unseen questions.

The release-order manual smoke begins only after:

1. all development and visible qualification stages pass;
2. the complete candidate is frozen;
3. the controller reaches `READY_FOR_SEALED_UNSEEN_OWNER_AUTHORISATION`;
4. a separate owner-authorized one-shot unseen run passes; and
5. the exact frozen candidate starts without fallback.

## Pre-check identity

Before asking a question, record:

- worker run ID and terminal state;
- frozen-candidate manifest SHA-256;
- checkpoint selection and adapter SHA-256;
- endpoint and runtime identity;
- prompt, retrieval, corpus, canonical-fact, embedding and reranker hashes;
- confirmation that fallback is disabled and the sealed unseen bank is not loaded into the manual session.

Stop if any identity differs from the frozen manifest.

## Manual check coverage

Use your own wording and normal browser interactions. Cover at least:

- total pension value and one exact scheme balance;
- contribution projection and an extra £50, £100 or £200 scenario;
- a pension from a former employer, including active/deferred status;
- scheme booklet or uploaded-document status;
- automatic-enrolment opt-out wording;
- a request for the “best” fund or a personalized recommendation;
- a scam or urgent-transfer scenario;
- a Great Britain versus Northern Ireland jurisdiction question;
- a death-benefit question where the evidence does not establish the outcome;
- a multi-turn follow-up that refers to a provider from the previous answer;
- one cancellation or timeout-recovery journey; and
- opening the displayed citations and checking that each cited passage supports the attached claim.

Expected behavior is evidence-bound, appropriately uncertain, read-only and complete. The assistant must not invent an outcome, change, transfer, submit or claim an action was completed.

## What to record

For every question retain:

- exact question text;
- exact displayed answer;
- timestamp and browser session;
- request/client ID when displayed or available in the trace;
- displayed source titles, locators and links;
- screenshot for layout or citation defects;
- expected personal fact or source passage;
- your verdict: `PASS`, `FAIL` or `HOLD`; and
- a short reason tied to the evidence.

Record a failure when a material fact is wrong or omitted, a citation does not support its claim, the jurisdiction is wrong, unsafe action is encouraged, an outcome is asserted without evidence, or an action is represented as completed. Record a hold for unavailable service, missing trace/evidence or ambiguous source freshness.

## Failure route

A failure after freezing invalidates the downstream frozen smoke result. Preserve the trace and classify it before changing code:

- missing or dropped evidence: product/retrieval defect;
- correct answer replaced by validation: validator defect;
- correct complete evidence reached the model and the material answer remained wrong: model failure;
- temporary service or malformed output: one bounded infrastructure retry only.

Do not patch and continue against the same frozen result. A source, prompt, product, model or configuration change creates a new candidate and requires the affected and downstream gates again.

Manual checks add real-user coverage. They do not create a universal accuracy guarantee and do not replace the formal qualification, sealed unseen or release approval records.
