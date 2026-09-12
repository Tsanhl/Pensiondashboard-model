import assert from "node:assert/strict";
import test from "node:test";
import { assertCommandAllowed, assertNoProtectedCredentials, assertPathAllowed } from "../scripts/lib/qualification-worker/protectedPaths.mjs";
import { validateRepairProposal } from "../scripts/lib/qualification-worker/repairPolicy.mjs";

const config = { permissions: { allow_training: false, allow_sealed_unseen: false, allow_release: false, allow_git_push: false, allow_origin_change: false, allow_narrow_product_repairs: true } };

test("protected unseen paths and credentials are fail-closed", () => {
  assert.throws(() => assertPathAllowed(process.cwd(), "evaluation/sealed-unseen/gold.json", ["sealed-unseen"]), /Protected path refused/);
  assert.throws(() => assertNoProtectedCredentials({ SEALED_UNSEEN_KEY: "present" }), /credential present/);
  assert.doesNotThrow(() => assertNoProtectedCredentials({ NORMAL_SETTING: "ok" }));
});

test("worker command policy refuses training, unseen, release and git push", () => {
  assert.throws(() => assertCommandAllowed("git", ["push", "origin"], config), /git push/);
  assert.throws(() => assertCommandAllowed("node", ["scripts/t4TrainCleanCumulative.mjs"], config), /training/);
  assert.throws(() => assertCommandAllowed("node", ["scripts/evaluationCycleV1SealedUnseenOneShot.mjs"], config), /sealed unseen/);
  assert.doesNotThrow(() => assertCommandAllowed("node", ["scripts/t4PostTrainingDevelopmentEval.mjs"], config));
});

test("automatic repairs require an allowlisted recipe, paths and tests", () => {
  assert.equal(validateRepairProposal({ recipe: "single_retry", files: ["server/services/localModelService.js", "test/retry.test.mjs"], tests: ["node --test test/retry.test.mjs"] }, config).allowed, true);
  assert.equal(validateRepairProposal({ recipe: "change_legal_rule", files: ["training/gold.json"], tests: [] }, config).allowed, false);
});
