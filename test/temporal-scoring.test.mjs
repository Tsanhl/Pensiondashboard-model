import assert from "node:assert/strict";
import test from "node:test";
import { resolveQuestionDateEllipsis, deathBeforePensionIhtCommencement } from "../scripts/lib/temporalScoring.mjs";

const question = "A member dies on 5 April 2027 and the pension death benefit is paid in May 2027. Which date governs?";
const rule = "The reform applies to deaths on or after 6 April 2027. ";

test("date ellipsis resolves only unique question dates and never overwrites a stated year", () => {
  assert.equal(resolveQuestionDateEllipsis("The 5 April death", question), "The 5 April 2027 death");
  assert.equal(resolveQuestionDateEllipsis("The 5 April 2026 death", question), "The 5 April 2026 death");
  assert.equal(resolveQuestionDateEllipsis("The 5 April death", "5 April 2026 or 5 April 2027?"), "The 5 April death");
  assert.equal(resolveQuestionDateEllipsis("The 6 April death", question), "The 6 April death");
});

test("IHT scoring accepts equivalent date-boundary application, not one magic phrase", () => {
  for (const application of [
    "A death on 5 April 2027 is outside the new regime; the death date, not payment date, controls this boundary.",
    "A 5 April death is outside it even though payment occurs later.",
    "A 5 April 2027 death is not within the new regime despite the benefit being paid in May.",
    "The reform does not apply to the 5 April 2027 death. The payment date does not affect that boundary.",
  ]) assert.equal(deathBeforePensionIhtCommencement(rule + application, question), true, application);
});

test("IHT scoring still rejects missing application, wrong years, wrong boundary and payment-date overrides", () => {
  for (const text of [
    rule,
    rule + "The death date matters and May is later.",
    rule + "A 5 April 2026 death is outside it even though payment occurs later.",
    rule.replace("2027", "2028") + "A 5 April death is outside it even though payment occurs later.",
    rule + "A 5 April death is within it because payment occurs later.",
    rule + "A 5 April death is outside it even though payment occurs later. The payment date controls eligibility.",
  ]) assert.equal(deathBeforePensionIhtCommencement(text, question), false, text);
  assert.equal(deathBeforePensionIhtCommencement(rule + "A 5 April death is outside it even though payment occurs later.", "The member died in April."), false);
});
