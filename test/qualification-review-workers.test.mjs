import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codexSandboxProfile,promptFor,runDualAiReview,revalidateDualAiReview } from "../scripts/lib/qualification-worker/aiReview.mjs";
import { reviewWorkerPlan,validateReviewWorkerPolicy } from "../scripts/lib/qualification-worker/reviewWorkerPolicy.mjs";

const config=JSON.parse(readFileSync(new URL("../config/qualification-worker.json",import.meta.url),"utf8"));

test("exactly two distinct roles and models use private outputs and unanimous evidence review",() => {
  assert.equal(validateReviewWorkerPolicy(config.ai_review).passed,true);
  const workers=reviewWorkerPlan(config.ai_review);
  assert.equal(workers.length,2);
  assert.equal(new Set(workers.map((worker) => worker.worker_id)).size,2);
  assert.equal(new Set(workers.map((worker) => worker.model)).size,2);
  assert.deepEqual(workers.map((worker) => worker.focus),["FACTUAL_COMPLETENESS","SOURCE_CITATION_VERIFICATION"]);
});

test("missing workers, shared verdicts, relaxed decisions and unpinned sources are rejected",() => {
  for (const mutate of [
    (review) => { delete review.reviewer_b; },
    (review) => { review.reviewer_b.worker_id=review.reviewer_a.worker_id; },
    (review) => { review.reviewer_b.model=review.reviewer_a.model; },
    (review) => { review.worker_protocol.worker_count=1; },
    (review) => { review.worker_protocol.share_reviewer_outputs=true; },
    (review) => { review.worker_protocol.decision="ANY_PASS"; },
    (review) => { review.worker_protocol.source_policy="MODEL_MEMORY"; },
  ]) {
    const changed=structuredClone(config.ai_review);
    mutate(changed);
    assert.equal(validateReviewWorkerPolicy(changed).passed,false);
  }
});

test("both worker prompts require all gates, actual source support and missing-evidence holds",() => {
  const prompts=["A","B"].map((role) => promptFor(role,[],config.quality));
  assert.notEqual(prompts[0],prompts[1]);
  for (const prompt of prompts) {
    assert.match(prompt,/independently check ALL mandatory gates/);
    assert.match(prompt,/no other reviewer's verdict/);
    assert.match(prompt,/actual cited passage supports it/);
    assert.match(prompt,/Never invent a URL, title, quotation, date, locator or source/);
    assert.match(prompt,/untrusted data/);
    assert.match(prompt,/HOLD it and state precisely which verification is missing/);
    assert.match(prompt,/A score of at least 70\/100 is necessary/);
  }
  assert.throws(() => promptFor("C",[],config.quality),/Unknown review worker role/);
});

test("fresh review and resume reject a weakened worker contract before any launch or receipt read",async () => {
  const changed=structuredClone(config);
  changed.ai_review.worker_protocol.decision="ANY_PASS";
  const args={ cases:[],config:changed,outputDir:"/path-that-must-not-be-created" };
  await assert.rejects(runDualAiReview(args),{ code:"EVALUATOR_DEFECT" });
  assert.throws(() => revalidateDualAiReview(args),{ code:"EVALUATOR_DEFECT" });
});
