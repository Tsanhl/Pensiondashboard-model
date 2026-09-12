import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateConfig } from "../scripts/lib/qualification-worker/gateValidators.mjs";
import { statusMarkdown } from "../scripts/lib/qualification-worker/reporting.mjs";

const config=JSON.parse(readFileSync(new URL("../config/qualification-worker.json",import.meta.url),"utf8"));

test("the owner-selected AI route does not grant training, unseen, release, repair or qualification",() => {
  assert.equal(validateConfig(config).passed,true);
  assert.equal(config.review_selection.selected_route,"AI");
  assert.equal(config.review_selection.selected_by,"OWNER");
  assert.equal(config.start_state,"VERIFY_RUNTIME");
  for (const key of ["allow_training","allow_sealed_unseen","allow_release","allow_narrow_product_repairs"]) assert.equal(config.permissions[key],false);
  assert.equal(config.quality.minimum_score,70);
  assert.equal(config.quality.minimum_ai_agreement,2);
  assert.equal(config.quality.require_all_hard_factual_gates,true);
});

test("a route switch, fallback or universal accuracy claim cannot silently bypass the pinned policy",() => {
  for (const [key,value,reason] of [
    ["selected_route","HUMAN",/owner-selected AI route/],
    ["selected_by","AGENT",/owner-selected AI route/],
    ["automatic_fallback",true,/owner-selected AI route/],
    ["claim_scope","ALL_POSSIBLE_ANSWERS",/review claims must be limited/],
    ["universal_accuracy_guarantee",true,/review claims must be limited/],
  ]) {
    const changed=structuredClone(config);
    changed.review_selection[key]=value;
    const result=validateConfig(changed);
    assert.equal(result.passed,false);
    assert.match(result.blockers.join(";"),reason);
  }
});

test("status displays selection without clearing blocked state or rewriting historical reviewer identity",() => {
  const state={ state:"BLOCKED_NOT_QUALIFIED",completed_stages:[],blocker:"Runtime startup failed",selected_iteration:104 };
  assert.match(statusMarkdown(state),/not recorded in this historical run/);
  const selected=statusMarkdown({ ...state,review_selection:config.review_selection });
  assert.match(selected,/Review route for this run: \*\*AI\*\*/);
  assert.match(selected,/Completed gates: \*\*0\*\*/);
  assert.match(selected,/BLOCKED_NOT_QUALIFIED/);
});
