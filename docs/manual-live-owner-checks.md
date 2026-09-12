# Owner manual live checks

## When to use this checklist

The current candidate is `DEVELOPMENT_NOT_QUALIFIED`: Q1 and its development variants have not met substantive answer acceptance. The historical run failed before a gate completed; the fresh run remains NOT_RUN. See [current repair report](LIVE-ASSISTANT-REPAIR-REPORT.md).

You may use the dashboard for exploratory development checks using the working owned local runtime, but label those checks `DEVELOPMENT_ONLY`. They do not replace the controller gates and must not use sealed unseen questions.

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

## 8 September development repair addendum

See `LIVE-ASSISTANT-REPAIR-REPORT.md` and `LIVE-ASSISTANT-RUNBOOK.md`. The source has development repairs but is still not qualified; the release-order prerequisites above remain mandatory. Use only DEVELOPMENT_ONLY questions and isolated data until those gates pass.

For each of the six owner messages, verify the visible terminal answer/error, its request identity, profile and sources. In particular: Q1 must give supported general scheme-change information (currently failing); Q2 must show immediate protection with reviewed official provenance (current output is only a general notice); Q3 must retain baseline plus all three stored scenarios and disclose input assumptions; Q4 must distinguish extracted values from confirmation and identify missing locators. Check `??` and `why fail` after a real error, then deliberately Retry.

Repeat Q2/Q3, change pages, reload and switch to the empty profile. Confirm no sample values migrate to another user, no duplicate generation occurs, completed answers survive history failure, Cancel terminates and the browser never represents a progress label as proof of generation. Expand the source evidence and compare each account rate with account evidence and each forecast with projection evidence. Record untested paths as NOT_RUN, not PASS.
