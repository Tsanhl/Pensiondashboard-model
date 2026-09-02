# Pensiondashboard-model

Fail-closed public snapshot of the pensions dashboard application.

**This repository is not a live-qualified model release.** Visible development qualification run `20260902-recovery-step130-v4` failed at the 161-case topic gate. The sealed unseen set was not opened and was not executed. `npm run live:local` remains refused until a later run actually passes the authorised gates.

## What passed and what failed

| Stage | Result |
| --- | --- |
| critical4 | passed 4/4 |
| full69 consumer / adversarial / advanced-law suites | passed 69/69 |
| topic161 Wave 1 | failed 36/52 (69.2%), 2 critical, 2 run errors |
| topic161 Wave 2 | failed 33/68 (48.5%), 18 critical, 14 run errors |
| topic161 Wave 3 | failed 20/41 (48.8%), 13 critical, 3 run errors |
| frozen13 / final visible gate | not reached |
| sealed unseen | not run |
| owner-local live approval | not issued |

Hashes for the closed record and failed topic161 gate are in `release-evidence/QUALIFICATION-SUMMARY.json`. Thresholds were not lowered.

## Included and deliberately excluded

Included: runnable application source, application tests, fail-closed Render configuration, approved-corpus *manifest metadata*, and the visible-qualification failure evidence.

Excluded: the 4.6 GB Qwen3-8B-4bit base model, LoRA adapter weights, raw approved-corpus text, private training exports, databases, logs, secrets, sealed unseen questions/gold answers, and all per-case unseen output.

Public hosting on Render's free tier cannot serve the local 4.7 GB model. The checked-in `render.yaml` stays fail-closed and expects independently provisioned model, embedding, storage and scanning endpoints.

## Local development (not a qualification pass)

On an Apple Silicon Mac, after installing Node.js 22+ and Python 3:

```bash
npm install
cp .env.example .env
npm run check
npm test
```

The owner-local launcher will refuse an unapproved default release. That is intentional. Development serving uses a separately downloaded base model and a locally retained adapter, then:

```bash
npm run model:serve:pinned
npm run retrieval:serve
npm start
```

Open `http://127.0.0.1:3000`. Answers from this path are development output only.

## Safety and legal boundary

The assistant is read-only. It must abstain or hand off when evidence is missing, conflicting or outside scope. It cannot transfer money, change contributions, submit forms or provide regulated advice. Output is general information and routing support, not a substitute for a solicitor, regulated financial adviser, scheme administrator, HMRC or the relevant pensions regulator/ombudsman.
