export const REVIEW_WORKERS = Object.freeze({
  A:Object.freeze({ worker_id:"pensions-factual-review-a",name:"Factual accuracy and completeness",focus:"FACTUAL_COMPLETENESS" }),
  B:Object.freeze({ worker_id:"pensions-evidence-review-b",name:"Source and citation verification",focus:"SOURCE_CITATION_VERIFICATION" }),
});

export const REVIEW_WORKER_PROTOCOL = Object.freeze({
  worker_count:2,
  execution:"ISOLATED_SEQUENTIAL",
  decision:"BOTH_PASS_ALL_GATES",
  source_policy:"PINNED_CASE_EVIDENCE_ONLY",
  share_reviewer_outputs:false,
});

export function reviewWorkerPlan(aiReview) {
  return Object.entries(REVIEW_WORKERS).map(([role,worker]) => ({
    ...worker,role,provider:aiReview?.provider,
    model:aiReview?.[`reviewer_${role.toLowerCase()}`]?.model,
    reasoning_effort:aiReview?.[`reviewer_${role.toLowerCase()}`]?.reasoning_effort,
  }));
}

export function validateReviewWorkerPolicy(aiReview) {
  const blockers=[];
  const protocol=aiReview?.worker_protocol;
  if (!protocol || Object.keys(protocol).length!==Object.keys(REVIEW_WORKER_PROTOCOL).length
      || Object.entries(REVIEW_WORKER_PROTOCOL).some(([key,value]) => protocol[key]!==value)) {
    blockers.push("two isolated review workers with unanimous approval, pinned evidence and no shared verdicts are required");
  }
  for (const [role,worker] of Object.entries(REVIEW_WORKERS)) {
    const configured=aiReview?.[`reviewer_${role.toLowerCase()}`];
    if (configured?.worker_id!==worker.worker_id || configured?.focus!==worker.focus) blockers.push(`review worker ${role} identity or responsibility differs from the approved role`);
  }
  if (!aiReview?.reviewer_a?.model || !aiReview?.reviewer_b?.model || aiReview.reviewer_a.model===aiReview.reviewer_b.model) blockers.push("the two review workers must retain distinct configured model identities");
  return { passed:blockers.length===0,blockers };
}
