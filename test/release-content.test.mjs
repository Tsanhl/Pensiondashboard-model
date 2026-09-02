import assert from "node:assert/strict";
import test from "node:test";
import { wave1ConstructSupported, assertsSameGbNiLegislation } from "../scripts/lib/releaseContentChecks.mjs";

test("source hierarchy checks require operative transfer law, not generic scheme-rule language", () => {
  const focus = "wave-1.evidence-citation.current_law_vs_consultation";
  assert.equal(wave1ConstructSupported(focus, "Apply the 2021 transfer-condition regulations. The consultation is a proposal, and regulator guidance is non-binding."), true);
  assert.equal(wave1ConstructSupported(focus, "The governing rule is the scheme rules. Consultation and guidance do not override the scheme rules."), false);
});

test("a red-flag keyword alone does not prove the statutory-stop and no-waiver propositions", () => {
  const focus = "wave-1.transfers-scams.red_flag_stop";
  assert.equal(wave1ConstructSupported(focus, "An established red flag means the Second Condition is not satisfied. Member consent cannot override that stop."), true);
  assert.equal(wave1ConstructSupported(focus, "Trustees must refuse some transfers. Failure to provide specified guidance evidence is a red flag."), false);
});

test("cross-border and complaint checks require distinct relevant issues", () => {
  assert.equal(wave1ConstructSupported("x.ni_cross_border_transfer", "Analyse Northern Ireland safeguards, UK tax/QROPS status and Irish destination regulation separately."), true);
  assert.equal(wave1ConstructSupported("x.ni_cross_border_transfer", "Under Northern Ireland law pension credit rights may be transferred overseas."), false);
  assert.equal(wave1ConstructSupported("x.tpo_vs_fos", "The adviser complaint goes first to the firm, then FOS; administration delay goes through IDRP and TPO."), true);
});

test("NI source IDs cannot excuse an answer asserting the same GB legislation", () => {
  assert.equal(assertsSameGbNiLegislation("The same automatic-enrolment regulations apply as in England."), true);
  assert.equal(assertsSameGbNiLegislation("Do the same regulations apply as in England? No, Northern Ireland has separate legislation."), false);
  assert.equal(assertsSameGbNiLegislation("The same regulations do not apply as in England."), false);
  assert.equal(assertsSameGbNiLegislation("Northern Ireland has a separate legislative framework even where the requirements are similar."), false);
});
