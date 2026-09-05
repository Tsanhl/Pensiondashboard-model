const ALLOWLIST = new Set([
  "deterministic_dashboard_recap", "intent_to_structured_lookup", "source_priority", "context_source_ordering",
  "safe_fixed_wording", "single_retry", "timeout_configuration", "static_jurisdiction_exclusion",
  "citation_formatting", "evaluator_parsing", "claim_level_validator",
]);

const ALLOWED_PREFIXES = ["server/services/", "server/prompts/", "scripts/", "test/"];

export function validateRepairProposal(proposal, config) {
  const errors = [];
  if (!config.permissions.allow_narrow_product_repairs) errors.push("product repairs are disabled");
  if (!ALLOWLIST.has(proposal.recipe)) errors.push(`recipe is not allowlisted: ${proposal.recipe}`);
  if (!Array.isArray(proposal.files) || proposal.files.some((path) => !ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)))) errors.push("repair touches a non-allowlisted path");
  if ((proposal.files || []).some((path) => /(?:train.*adapter|adapter.*train)|(?:^|[/_.-])(?:train|training|gold|unseen|checkpoint|adapter)(?:[/_.-]|$)/i.test(path))) errors.push("repair touches training, model, gold, checkpoint, adapter, or unseen material");
  if (!Array.isArray(proposal.tests) || proposal.tests.length === 0) errors.push("repair has no regression test");
  if (/gold|threshold|training.data|legal.rule|legal.conclusion/i.test(JSON.stringify(proposal))) errors.push("repair attempts a protected substantive change");
  return { allowed: errors.length === 0, errors };
}

export const repairRecipes = Object.freeze([...ALLOWLIST]);
