import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCumulativeTrainingIsolation, auditTrainingPartitionIsolation, auditTrainingRows, contentHash, loadReviewedTrainingItems } from "../scripts/lib/trainingEvidenceIntegrity.mjs";

const target = "The requested payment depends on the governing scheme rules and the relevant statutory conditions; the supplied label alone cannot establish entitlement.";
const row = (evidence, output = target) => ({ metadata:{ training_id:"test-training" }, messages:[{ role:"user", content:JSON.stringify({ evidence:[{ text:evidence }] }) }, { role:"assistant", content:output }] });

test("training rejects answer-as-evidence even with renamed IDs, citation tokens or JSON targets", () => {
  for (const output of [target + " {{cite:invented-disjoint-id}}", JSON.stringify({ answer:target + " {{cite:S1}}", citation_ids:["S1"] })]) {
    const audit = auditTrainingRows([row(target, output)]);
    assert.equal(audit.passed, false);
    assert.equal(audit.target_in_evidence, 1);
  }
});

test("independent raw evidence is not rejected merely for covering the same subject", () => {
  const audit = auditTrainingRows([row("Rule 7 permits payment only with the consent of the decision-maker, subject to the statutory minimum age.")]);
  assert.equal(audit.passed, true);
  assert.equal(audit.json_answer_contract, 0);
});

test("validation isolation checks text, authority families and constructs, not renamed IDs alone", () => {
  const item = (id, text, family, construct) => ({ training_id:id, construct_id:construct, retrieved_evidence:[{ source_id:id, text, authority_family:family }] });
  const training = [item("train", "Original source passage.", "law-a", "rule-a")];
  assert.equal(auditTrainingPartitionIsolation(training, [item("valid", "Different source.", "law-b", "rule-b")]).passed, true);
  assert.equal(auditTrainingPartitionIsolation(training, [item("renamed", "Original source passage!", "law-b", "rule-b")]).passed, false);
  assert.equal(auditTrainingPartitionIsolation(training, [item("valid", "Different source.", "law-a", "rule-b")]).passed, false);
  assert.equal(auditTrainingPartitionIsolation(training, [item("valid", "Different source.", "law-b", "rule-a")]).passed, false);
  assert.equal(auditTrainingPartitionIsolation(training, [item("valid", "Different source.", "law-b", "")]).passed, false);
});

test("cumulative isolation catches a later training collision with earlier validation", () => {
  const item = (id, text, family, construct) => ({ training_id:id, construct_id:construct, retrieved_evidence:[{ source_id:id, text, authority_family:family }] });
  const audit = auditCumulativeTrainingIsolation([
    { wave:2, train:[item("w2-train", "first source", "family-a", "rule-a")], validation:[item("w2-valid", "held-out source", "family-held", "wording-one")] },
    { wave:3, train:[item("w3-train", "later source", "family-b", "wording-two")], validation:[item("w3-valid", "other held-out source", "family-c", "rule-c")] },
  ], { legalRuleById:{ "w2-valid":"shared-rule", "w3-train":"shared-rule" } });
  assert.equal(audit.passed, false);
  assert.deepEqual(audit.overlap.constructs, ["shared-rule"]);
});

test("review approval must bind question, source content, citation mapping and item hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "training-evidence-test-"));
  const path = join(directory, "review.json");
  const question = "What information is needed to check this payment?";
  const evidence = "Rule 7 permits payment only with the consent of the decision-maker, subject to the statutory minimum age.";
  const items = [{ training_id:"t1", question_sha256:contentHash(question), review_status:"approved", ideal_answer:target + " {{cite:law-7}}", retrieved_evidence:[{ source_id:"law-7", text:evidence, source_url:"https://example.org/law", authority_family:"test-law", content_sha256:contentHash(evidence) }] }];
  const review = { status:"approved_for_training", reviewer:"test-only-reviewer", approved_at:"2026-09-01", items, items_sha256:contentHash(JSON.stringify(items)) };
  writeFileSync(path, JSON.stringify(review));
  assert.equal(loadReviewedTrainingItems(path, [{ id:"t1", question }]).byId.size, 1);
  review.items[0].retrieved_evidence[0].text = target;
  writeFileSync(path, JSON.stringify(review));
  assert.throws(() => loadReviewedTrainingItems(path, [{ id:"t1", question }]), /hash-bound/);
  review.items_sha256 = contentHash(JSON.stringify(items));
  writeFileSync(path, JSON.stringify(review));
  assert.throws(() => loadReviewedTrainingItems(path, [{ id:"t1", question }]), /provenance/);
  review.items[0].retrieved_evidence[0].content_sha256 = contentHash(target);
  review.items_sha256 = contentHash(JSON.stringify(items));
  writeFileSync(path, JSON.stringify(review));
  assert.throws(() => loadReviewedTrainingItems(path, [{ id:"t1", question }]), /copies its completion/);
});

test("a returned review needs hash-bound verified repairs, not changed approval flags", () => {
  const directory = mkdtempSync(join(tmpdir(), "training-review-return-test-"));
  const path = join(directory, "review.json");
  const returnedPath = join(directory, "returned.json");
  const question = "What information is needed?";
  const evidence = "The applicable rule requires the administrator to obtain the specified information before deciding the request.";
  const items = [{ training_id:"t1", question_sha256:contentHash(question), review_status:"approved", ideal_answer:"The information must be obtained before deciding. {{cite:law}}", retrieved_evidence:[{ source_id:"law", text:evidence, source_url:"https://example.org/law", authority_family:"law", content_sha256:contentHash(evidence) }] }];
  const returned = JSON.stringify({ status:"returned_for_revision" });
  writeFileSync(returnedPath, returned);
  const review = { status:"approved_for_training", reviewer:"reviewer", approved_at:"2026-09-01", items, items_sha256:contentHash(JSON.stringify(items)) };
  writeFileSync(path, JSON.stringify(review));
  assert.throws(() => loadReviewedTrainingItems(path, [{ id:"t1", question }], { reviewReturnPath:returnedPath }), /returned for revision/);
  review.repairs_verified = true;
  review.supersedes_review_return_sha256 = contentHash(returned);
  writeFileSync(path, JSON.stringify(review));
  assert.equal(loadReviewedTrainingItems(path, [{ id:"t1", question }], { reviewReturnPath:returnedPath }).byId.size, 1);
});
