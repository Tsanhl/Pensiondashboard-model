export function sanitizeSafetyWording(text) {
  return String(text || "")
    .replace(/\bcontact the scammers?\b/gi, "contact the provider through independently verified details")
    .replace(/\bcontact the caller\b/gi, "contact the provider through independently verified details")
    .replace(/\bcontact the promoter\b/gi, "contact the provider through independently verified details");
}

export function containsUnsafeScamWording(text) {
  return /\bcontact the scammers?\b/i.test(String(text || ""));
}

export function deathBenefitOutcomeUnsafe(question, answer) {
  if (!/\b(?:die before|death benefit|if i die|when i die|expression of wish)\b/i.test(String(question || ""))) return false;
  const text = String(answer || "");
  if (/\b(?:scheme(?:-specific)? rules?|cannot (?:say|determine|confirm)|depends|human review|ask (?:the |your )?provider)\b/i.test(text)) return false;
  return /\b(?:spouse|widow(?:er)?|nominee|civil partner|partner|children?|dependants?)\b/i.test(text)
    && /\b(?:receives?|will receive|get(?:s)? the|same terms|inherit|paid to)\b/i.test(text);
}

export const DEATH_BENEFIT_FAIL_CLOSED = "Death benefits depend on the scheme rules, any valid nomination or expression of wish, and the provider's process. I cannot say from the dashboard pots who would receive benefits or on what terms. Ask the scheme administrator or a regulated adviser, and keep any nomination up to date.";
