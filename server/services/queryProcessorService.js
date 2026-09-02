const INTENTS = new Set([
  "GENERAL_PENSION_FAQ", "USER_PORTFOLIO", "USER_DOCUMENT", "PENSION_LAW", "PROJECTION", "HYBRID",
  "UNSUPPORTED_ACTION", "HUMAN_HANDOFF"
]);

const RESPONSE_ROUTES = new Set([
  "ANSWER", "ANSWER_AND_HANDOFF", "REFUSE_ACTION", "SECURITY_FALLBACK", "HUMAN_HANDOFF"
]);

const TAX_PATTERN = /\b(?:hmrc|tax(?:ation)?|tax year|annual allowance|money purchase annual allowance|mpaa|tapered allowance|threshold income|adjusted income|lifetime allowance|lump[- ]sum allowances?|lsa|lsdba|overseas transfer charge|qrops)\b/i;
const LEGAL_REFERENCE_PATTERN = /\b(?:section|article|regulation|schedule|paragraph)\s+\d+[a-z]?(?:\([0-9a-z]+\))*/i;
const PENSION_RULE_PATTERN = /\b(?:automatic[- ]enrolment|auto[- ]?enrolment|re[- ]?enrolment|opt(?:ed)? out|preservation|preserved pension|benefits? preserved|revaluation|indexation|statutory transfer|cash equivalent(?: transfer value)?|cetv|safeguarded benefits?|safeguarded features?|guarantee(?:d|s)? (?:an? )?annuity rate|cash[- ]balance benefits?|collective money purchase|collective defined contribution|\bcdc\b|master trust|group personal pension|State Pension|public[- ]service pension|council pension|workplace DC|scheme classification|individual investment account|red flag|amber flag|(?:pension|transfer) scam|transfer checks?|unlock (?:my |a )?pension|normal (?:minimum )?pension age|protected pension age|small[- ]pot(?: lump sum)?|trivial commutation|serious ill[- ]health lump sum|commutation|trustees?|scheme amendment|section 67|rpi|cpi|ill[- ]health pension|climate risk|statement of investment principles|actuarial valuation|technical provisions?|funding deficit|funding code|funding[- ]and[- ]investment[- ]strategy|statement[- ]of[- ]strategy|recovery plan|schedule of contributions|contribution notice|clearance|notifiable event|employer covenant|multi[- ]employer scheme|Fast Track|Bespoke|low dependency|significant(?:ly)? mature|\bsip\b|pension protection fund|\bppf\b|pensions ombudsman|ombudsman|complaint|appeal|\btpo\b|survivor(?:'s)? pension|same[- ]sex|civil partner|disab(?:led|ility)|reasonable adjustment|age discrimination|age[- ]based|sex equality|part[- ]time worker|gender reassignment|McCloud|remedial pension savings statement|guaranteed minimum pensions?|gmp equalisation|pension sharing|pension attachment|divorc(?:e|ing)?|tupe|service provision change|employer debt|section 75|overpayment|overpaid|expression of wish|death benefit|missing contribution|pension contributions?|future pension accrual|consult members|flexible benefits|scheme rules?|additional voluntary contributions?|\bAVCs?\b|value data|pensions? dashboards?|dashboards?)\b/i;
const PERSONAL_DATA_PATTERN = /\b(?:my|mine|i took|this pension|account|provider|balance|pot|charge|guarantee|contribution|allocation|policy|dashboard|payslip|shown here)\b/i;
const PUBLIC_GUIDANCE_PATTERN = /\b(?:defined benefit|defined contribution|workplace pension|employer contributions?|pension value|transfer|transferr?ing|cash equivalent|missing from my dashboard|appears twice|duplicate|never worked for|surname|address|current value|retirement income|projection assumptions?|assumptions|payslip|pension deductions?|see the other pensions|state pension forecast|take this pension at|death benefit)\b/i;

function normaliseJurisdiction(value) {
  const text = String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (!text) return "UNSPECIFIED";
  if (["northern_ireland", "ni", "n._i."].includes(text)) return "NORTHERN_IRELAND";
  if (["england_and_wales", "england_&_wales", "e&w"].includes(text)) return "ENGLAND_AND_WALES";
  if (text === "scotland") return "SCOTLAND";
  if (["great_britain", "gb", "england", "wales"].includes(text)) return "GREAT_BRITAIN";
  if (["gb_and_ni", "united_kingdom", "uk", "uk_wide"].includes(text)) return "GB_AND_NI";
  if (["uk_tax", "united_kingdom_tax"].includes(text)) return "UK_TAX";
  return "UNSPECIFIED";
}

function locationJurisdiction(text) {
  if (/\b(?:belfast|newry|lisburn|londonderry|derry|armagh|enniskillen|northern ireland)\b/i.test(text)) return "NORTHERN_IRELAND";
  if (/\b(?:cardiff|swansea|newport|wrexham|wales|welsh)\b/i.test(text)) return "ENGLAND_AND_WALES";
  if (/\b(?:glasgow|edinburgh|aberdeen|dundee|inverness|scotland)\b/i.test(text)) return "SCOTLAND";
  if (/\b(?:london|manchester|birmingham|leeds|liverpool|bristol|newcastle|england)\b/i.test(text)) return "ENGLAND_AND_WALES";
  return "UNSPECIFIED";
}

function detectJurisdiction(question, context = {}) {
  const text = String(question || "");
  const mentionedLocations = [
    /\b(?:belfast|newry|lisburn|londonderry|derry|armagh|enniskillen|northern ireland)\b/i.test(text) && "NORTHERN_IRELAND",
    /\b(?:cardiff|swansea|newport|wrexham|wales|welsh|london|manchester|birmingham|leeds|liverpool|bristol|newcastle|england)\b/i.test(text) && "GREAT_BRITAIN",
    /\b(?:glasgow|edinburgh|aberdeen|dundee|inverness|scotland|scottish)\b/i.test(text) && "SCOTLAND",
  ].filter(Boolean);
  if (new Set(mentionedLocations).size > 1 && /\b(?:which jurisdiction(?:al)? facts?|facts? must be established|which (?:law|regime) governs)\b/i.test(text)) return "UNSPECIFIED";
  if (/\b(?:compare|both|all)\b/i.test(text) && /\b(?:great britain|gb|england|wales|scotland)\b/i.test(text) && /\b(?:northern ireland|n\.?\s*i\.?)\b/i.test(text)) return "GB_AND_NI";

  const divorceLocation = text.match(/\bdivorc(?:e|ing)?\b[^?.!,;]{0,45}\b(?:in|before)\s+([^?.!,;]+)/i)?.[1] || "";
  const divorceJurisdiction = locationJurisdiction(divorceLocation);
  if (divorceJurisdiction !== "UNSPECIFIED") return divorceJurisdiction;

  const namedSchemeLocation = text.match(/\b(belfast|newry|lisburn|londonderry|derry|armagh|enniskillen|glasgow|edinburgh|aberdeen|dundee|inverness|cardiff|swansea|newport|wrexham|london|manchester|birmingham|leeds|liverpool|bristol|newcastle)\s+(?:occupational\s+|public[- ]service\s+|pension\s+)?scheme\b/i)?.[1] || "";
  const namedSchemeJurisdiction = locationJurisdiction(namedSchemeLocation);
  if (namedSchemeJurisdiction !== "UNSPECIFIED") return namedSchemeJurisdiction;
  const namedMemberLocation = text.match(/\b(belfast|newry|lisburn|londonderry|derry|armagh|enniskillen|glasgow|edinburgh|aberdeen|dundee|inverness|cardiff|swansea|newport|wrexham|london|manchester|birmingham|leeds|liverpool|bristol|newcastle)\s+member\b/i)?.[1] || "";
  const namedMemberJurisdiction = locationJurisdiction(namedMemberLocation);
  if (namedMemberJurisdiction !== "UNSPECIFIED") return namedMemberJurisdiction;

  if (/\bprovider(?:'s)?\s+[^?.!,;]{0,30}\baddress\b/i.test(text) && /\b(?:prove|establish|determin(?:e|es))\b/i.test(text)) return "UNSPECIFIED";

  // A person's stated work/residence/proceedings location controls over a
  // comparison jurisdiction mentioned later in the same question.
  const primaryLocation = text.match(/\b(?:i\s+(?:work|live|reside)|working|employed|divorcing|proceedings|company|scheme)\s+(?:in|is in|are in)\s+([^?.!,;]+)/i)?.[1] || "";
  const primary = locationJurisdiction(primaryLocation);
  if (primary !== "UNSPECIFIED") return primary;

  if (/\b(?:northern ireland|n\.?\s*i\.?)\b/i.test(text)) return "NORTHERN_IRELAND";
  if (/\b(?:england and wales|england & wales|e&w)\b/i.test(text)) return "ENGLAND_AND_WALES";
  if (/\bscotland\b/i.test(text)) return "SCOTLAND";
  if (/\b(?:great britain|g\.?\s*b\.?)\b/i.test(text)) return "GREAT_BRITAIN";
  const location = locationJurisdiction(text);
  if (location !== "UNSPECIFIED") return location;
  if (/\b(?:united kingdom|uk[- ]wide)\b/i.test(text)) return "GB_AND_NI";

  return normaliseJurisdiction(context.resolvedEntities?.jurisdiction || context.jurisdiction);
}

function orderedProviders(context = {}) {
  const known = context.providers || [];
  const messages = [...(context.latestMessages || [])].reverse();
  for (const message of messages) {
    const content = String(message.content || "");
    const found = known.map((provider) => ({ provider,index:content.toLowerCase().indexOf(String(provider).toLowerCase()) }))
      .filter((item) => item.index >= 0).sort((left,right) => left.index - right.index).map((item) => item.provider);
    if (found.length) return [...new Set(found)];
  }
  return [];
}

function knownEntities(question, context = {}) {
  const entities = { ...(context.resolvedEntities || {}) };
  const jurisdiction = detectJurisdiction(question, context);
  if (jurisdiction !== "UNSPECIFIED") entities.jurisdiction = jurisdiction;
  const providers = context.providers || [];
  for (const provider of providers) {
    if (new RegExp(`\\b${String(provider).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question)) entities.provider = provider;
  }
  const policy = question.match(/\b(?:policy|plan|account)\s*(?:number|no\.?|#)?\s*([A-Z]{1,5}[- ]?\d{4,})\b/i);
  if (policy) entities.policyNumber = policy[1];
  const ordinal = question.match(/\b(first|second|third|last)(?:\s+(?:one|plan|account|provider))?\b/i)?.[1]?.toLowerCase();
  if (ordinal) {
    const ordered = orderedProviders(context);
    const index = ordinal === "first" ? 0 : ordinal === "second" ? 1 : ordinal === "third" ? 2 : Math.max(0, ordered.length - 1);
    if (ordered[index]) entities.provider = ordered[index];
  }
  return entities;
}

function pensionRuleQuestion(text) {
  return PENSION_RULE_PATTERN.test(text)
    || /\b(?:law|legal|legally|legislation|regulation|statutory|deadline|case law|judg(?:e)?ment|fca|pensions regulator)\b/i.test(text)
    || LEGAL_REFERENCE_PATTERN.test(text)
    || /\b(?:act|order|regulations?)\s+(?:19|20)\d{2}\b/i.test(text)
    || TAX_PATTERN.test(text);
}

function verifiedDashboardFactComparison(text) {
  return /\bwhich (?:one|provider|pension)\b[^.!?]{0,80}\b(?:lower|higher)\b[^.!?]{0,50}\b(?:annual )?charges?\b/i.test(text)
    || /\b(?:lower|higher)\b[^.!?]{0,50}\b(?:annual )?charges?\b[^.!?]{0,80}\b(?:shown on|in) (?:my |the )?dashboard\b/i.test(text);
}

function responseRoute(question) {
  const text = String(question || "").toLowerCase();
  const deceptiveAction = /\b(?:conceal|misdescribe|falsif(?:y|ied)|invent)\b[^.!?]{0,80}\b(?:incentive|employment|job|information|evidence)\b|\bdescribe\b[^.!?]{0,60}\bas (?:a |an )?reimbursement\b[^.!?]{0,80}\b(?:avoid|will not stop|won't stop)\b/i.test(text);
  const prohibitedAction = /(?:^|[.!?]\s*)(?:please\s+)?(?:submit|transfer|move|withdraw|change|switch|send|sign|contact|call|release|extend)\b/i.test(text)
    || /\bcan you\s+(?:submit|transfer|move|withdraw|change|switch|send|sign|contact|call|release|extend)\b/i.test(text)
    || /\b(?:asks? (?:the )?assistant to |do it|execute (?:it|the transfer)|make the change|on my behalf)\b[^.!?]{0,80}\b(?:submit|sign|transfer|file)\b/i.test(text)
    || /\b(?:submit|file)\b[^.!?]{0,50}\b(?:and\s+)?sign\b[^.!?]{0,40}\b(?:declaration|statement)\b/i.test(text)
    || deceptiveAction;
  if (prohibitedAction) return { route:"REFUSE_ACTION",reason:"read_only_action_boundary" };

  const scam = /\b(?:unlock|early access|access pension benefits? immediately)\b.*\bpension\b|\bpension benefits?\b[^.!?]{0,80}\b(?:immediately|before (?:age )?55|before (?:age )?57)\b|\b(?:guaranteed|risk[- ]?free)\b.*\breturn|\b(?:unsolicited|cold call|whatsapp|pressur(?:e|ed|ing)|urgent(?:ly)?[^.!?]{0,40}transfer|transfer today|completes? today|pay (?:a |the )?fee|release fee|shopping voucher|cash incentive)\b|\b(?:caller|promoter|firm)\b[^.!?]{0,100}\b(?:knows? (?:my |the )?(?:pension value|date of birth|account details)|proves? (?:they|it) (?:are|is) authorised)\b|\b(?:fraud|scam)\b[^.!?]{0,60}\b(?:now|urgent|warning|suspect|suspected|committing)\b/i.test(text);
  if (scam) return { route:"SECURITY_FALLBACK",reason:"possible_pension_scam_or_unauthorised_early_access" };

  if (/\b(?:speak to|talk to|refer me to|connect me to|human support|human adviser|human advisor|handoff)\b/i.test(text)) return { route:"HUMAN_HANDOFF",reason:"user_requested_human" };

  const personalisedAdvice = /\b(?:investment advice|recommend (?:a |an |the )?(?:fund|provider|investment|sipp)|which (?:fund|provider|investment)|should i (?:buy|sell|switch|invest|transfer)|best (?:fund|provider|investment)|change my allocation)\b/i.test(text);
  const safeguardedTransferAdvice = /\b(?:safeguarded benefits?|defined benefit|\bdb\b)\b[^.!?]{0,140}\b(?:transfer|proceed|recommend(?:ation)?|advice|suitab(?:le|ility))\b|\b(?:transfer|proceed|recommend(?:ation)?|advice|suitab(?:le|ility))\b[^.!?]{0,140}\b(?:safeguarded benefits?|defined benefit|\bdb\b)\b/i.test(text);
  const complaintRoutingQuestion = /\bcomplaint\b[^.!?]{0,120}\b(?:body|route|forum|fos|tpo)\b|\bwhich complaint body\b/i.test(text);
  const complexComplaintOrAppeal = /\b(?:which aspects? may fall to|fos,? tpo|tpo,? fos|appeal|appellate|court route)\b|\b(?:discretionary|death[- ]benefit)\b[^.!?]{0,100}\b(?:invalid|legally)\b/i.test(text);
  const individualLegalOutcome = /\b(?:is (?:the |this |that )?(?:change|amendment|decision|order) (?:automatically )?valid|will i win|what are my chances|can (?:the |a pension )?scheme pay a smaller survivor|does (?:that|this) prove i owe|can i use .* for (?:my )?divorce|section 75 (?:employer )?debt|replace rpi with cpi|ill[- ]health pension|earlier assurances matter legally|relevant to me after brexit|final pensions ombudsman determination.*appeal|divorcing|on divorce|overpaid my pension)\b/i.test(text);
  const crossBorderTax = /\btransfer\b[^.!?]{0,100}\b(?:to|into)\b[^.!?]{0,50}\boverseas\b|\boverseas (?:receiving )?scheme\b|\bprovider in (?:dublin|ireland|spain|france|hong kong|isle of man)\b/i.test(text);
  const niEmploymentTransfer = /\bnorthern ireland\b.*\b(?:transferr?ing|new employer|service provision change)\b/i.test(text);
  if (personalisedAdvice) return { route:"ANSWER_AND_HANDOFF",reason:"regulated_personalised_advice" };
  if (safeguardedTransferAdvice && !complaintRoutingQuestion) return { route:"ANSWER_AND_HANDOFF",reason:"regulated_pension_transfer_advice" };
  if (complexComplaintOrAppeal) return { route:"ANSWER_AND_HANDOFF",reason:"individual_legal_or_complaint_route_review" };
  if (crossBorderTax) return { route:"ANSWER_AND_HANDOFF",reason:"overseas_transfer_tax_review" };
  if (niEmploymentTransfer) return { route:"ANSWER_AND_HANDOFF",reason:"northern_ireland_employment_transfer_review" };
  if (individualLegalOutcome) return { route:"ANSWER_AND_HANDOFF",reason:"individual_legal_outcome" };
  if (/\buploaded transfer offer\b.*\bsafe\b|\bpension under an employer i have never worked for\b/i.test(text)) return { route:"SECURITY_FALLBACK",reason:"untrusted_document_or_possible_false_match" };
  if (/\b(?:member booklet|scheme booklet|member newsletter|newsletter)\b.*\b(?:executed )?scheme rules?\b|\b(?:executed )?scheme rules?\b.*\b(?:member booklet|scheme booklet|member newsletter|newsletter)\b|\bwhich one wins\b/i.test(text)) return { route:"ANSWER_AND_HANDOFF",reason:"conflicting_scheme_documents" };
  if (/\bexact pension value\b|\b(?:pension value|cash equivalent)\b[^.!?]{0,100}\b(?:no current statement|no scheme factors?|calculation date (?:is )?not available)\b/i.test(text)) return { route:"ANSWER_AND_HANDOFF",reason:"scheme_specific_value_review" };
  if (/\b(?:isle of man|channel islands?|non[- ]uk)\b[^.!?]{0,120}\b(?:pension|scheme|arrangement)\b|\b(?:pension|scheme|arrangement)\b[^.!?]{0,120}\b(?:isle of man|channel islands?|non[- ]uk)\b/i.test(text)) return { route:"ANSWER_AND_HANDOFF",reason:"non_uk_pension_law" };
  if (/\bdivorce\b[^.!?]{0,100}\b(?:scotland|england|wales|northern ireland)\b/i.test(text)) return { route:"ANSWER_AND_HANDOFF",reason:"cross_jurisdiction_divorce" };
  return { route:"ANSWER",reason:null };
}

function detectIntent(question, route) {
  const text = question.toLowerCase();
  if (route === "REFUSE_ACTION") return "UNSUPPORTED_ACTION";
  if (route === "HUMAN_HANDOFF") return "HUMAN_HANDOFF";
  const personalisedAdvice = /\b(?:investment advice|recommend (?:a |an |the )?(?:fund|provider|investment|sipp)|which (?:fund|provider|investment)|should i (?:buy|sell|switch|invest|transfer)|best (?:fund|provider|investment)|change my allocation)\b/.test(text);
  if (personalisedAdvice) return "HUMAN_HANDOFF";
  const law = pensionRuleQuestion(text);
  const portfolio = PERSONAL_DATA_PATTERN.test(text);
  const strongPortfolio = /\b(account|dashboard|balance|pot|contribution|allocation|projection|portfolio|payslip)\b/.test(text);
  const document = /\b(document|statement|letter|notice|uploaded|pdf|clause|scheme rules?)\b/.test(text)
    || (/\bsection\b/.test(text) && /\b(my|uploaded|document|statement|letter|pdf)\b/.test(text));
  const projection = /\b(project|projection|forecast|retire|retirement income|target|monthly gap|scenario)\b/.test(text);
  if (document && !law && !projection && !strongPortfolio) return "USER_DOCUMENT";
  if ([law, portfolio, document, projection].filter(Boolean).length > 1) return "HYBRID";
  if (law) return "PENSION_LAW";
  if (document) return "USER_DOCUMENT";
  if (projection) return "PROJECTION";
  if (portfolio) return "USER_PORTFOLIO";
  return "GENERAL_PENSION_FAQ";
}

function rewrite(question, context, entities) {
  const needsContext = /^(it|that|this|they|them|the (?:one|plan|account|provider)|what about|and |can i still)/i.test(question.trim()) || /\b(it|that one|the cheapest|this plan|first one|second one|third one|last one)\b/i.test(question);
  if (!needsContext) return question.trim();
  const anchors = [];
  if (entities.provider) anchors.push(`provider ${entities.provider}`);
  if (entities.policyNumber) anchors.push(`policy ${entities.policyNumber}`);
  if (entities.jurisdiction) anchors.push(`jurisdiction ${entities.jurisdiction.replaceAll("_", " ")}`);
  const prior = String(context.lastUserMessage || "").trim().slice(0, 500);
  const clean = question.trim().replace(/\b(?:it|that one|this plan|first one|second one|third one|last one)\b/gi, entities.provider || entities.policyNumber || "$&");
  const suffix = anchors.length ? ` (${anchors.join(", ")})` : prior ? ` (conversation context: ${prior})` : "";
  return `${clean}${suffix}`;
}

function requiresJurisdictionClarification(question, jurisdiction) {
  if (jurisdiction === "GB_AND_NI" && /\b(?:one set|all service|single (?:law|regime)|which (?:scheme|regulations?))\b/i.test(question)) return true;
  if (jurisdiction !== "UNSPECIFIED") return false;
  if (TAX_PATTERN.test(question)) return false;
  if (/\b(?:which jurisdiction(?:al)? facts?|facts? must be established before answering|uk based)\b/i.test(question)) return true;
  return /\b(?:automatic[- ]enrolment|preservation|statutory transfer|cash equivalent|red flag|amber flag|pension sharing|pension attachment|divorc(?:e|ing)?|tupe|service provision change|employer debt|section 75)\b/i.test(question);
}

function jurisdictionClarificationPrompt(question) {
  const text = String(question || "");
  if (/\b(?:manchester|belfast|glasgow)\b/i.test(text) && /\bjurisdiction(?:al)? facts?\b/i.test(text)) {
    return "Before answering, identify the exact legal issue and establish separately the scheme legislation, trust or governing law, employment location, member residence and any complaint forum. The administrator's location and the member's residence are not conclusive. Please provide the scheme's establishing or governing documents and the relevant employment connection.";
  }
  if (/\buk based\b/i.test(text) && /\btransfer[- ]condition\b/i.test(text)) {
    return "Please establish whether the transferring scheme is governed by Great Britain or Northern Ireland legislation and provide the connecting facts; 'UK based' is not enough. I would then retrieve the matching territorial transfer regulations rather than silently defaulting to Great Britain.";
  }
  if (/\bpublic[- ]service pension\b/i.test(text) && /\b(?:england|great britain)\b/i.test(text) && /\bnorthern ireland\b/i.test(text)) {
    return "One set of regulations cannot be assumed to govern all service. Public-service rights depend on the particular scheme's establishing regulations and the service period. Please provide the scheme, service dates and any transfer or remedy context so the England and Northern Ireland periods can be routed separately.";
  }
  if (/\boffshore\b/i.test(text) && /\bordinarily employed|ordinarily work/i.test(text)) {
    return "Please clarify where the worker was ordinarily working and the pattern and basis of the offshore work. I cannot guess the automatic-enrolment jurisdiction from the employer's headquarters or the member's residence; the statutory ordinary-work connection must be established.";
  }
  return "Please tell me whether this concerns Great Britain or Northern Ireland, because the applicable pension legislation may differ.";
}

function responseRequirements(question) {
  const text = String(question || "");
  const requirements = [];
  if (/\bpension from an employer\b[^.!?]{0,80}\bmissing from (?:my |the )?dashboard\b/i.test(text)) {
    requirements.push("State that a missing dashboard result does not mean the pension no longer exists. Explain matching, scheme-connection and data-availability possibilities conditionally; cite current official evidence for generic dashboard or tracing statements; and give only a verified scheme-contact or official pension-tracing route.");
  }
  if (/\bpension under an employer i have never worked for\b/i.test(text)) {
    requirements.push("Treat the record as a possible false match and never confirm ownership. Minimise repetition of potentially third-party data, cite current official public evidence for any dashboard-matching or privacy proposition, and direct the user to the secure false-match or privacy-incident workflow.");
  }
  if (/\b(?:same[- ]sex\b[^.!?]{0,100}\bsurvivor(?:'s)? pension|survivor(?:'s)? pension\b[^.!?]{0,100}\bsame[- ]sex)\b/i.test(text)) {
    requirements.push("State that same-sex status alone is not a lawful basis for a smaller survivor pension. Apply the exact rights, service dates, scheme wording and current statutory exception before reaching an individual outcome; cite the Equality Act 2010 and Walker v Innospec where relevant; and retain specialist handoff for the member-specific calculation.");
  }
  if (/\btake this pension at 55\b/i.test(text) && /\b2029\b/i.test(text)) {
    requirements.push("Distinguish the dashboard statement from the normal minimum pension age at the planned access date, any valid protected pension age and the scheme rules. Do not invent or calculate a current age, and do not confirm access at 55 or 57 without the missing protection and scheme facts. Cite current official tax law or HMRC guidance for the dated rule.");
  }
  if (/\b(?:normally|ordinarily) work(?:ed|ing)?\b/i.test(text) && /\bhead office\b/i.test(text)) {
    requirements.push("State the ordinary-work territorial connection, say expressly whether the employer's head-office address is determinative, and identify any temporary, offshore or cross-border facts that could make ordinary work uncertain.");
  }
  if (/\b(?:event|knowledge|awareness|complaint) dates?\b/i.test(text) && /\b(?:incomplete|missing|unknown)\b/i.test(text)) {
    requirements.push("Name each date needed before reaching a limitation or admissibility conclusion and explain any supported discretion without guaranteeing acceptance.");
  }
  if (/\bPensions Regulator\b/i.test(text) && /\bpersonal compensation\b/i.test(text)) {
    requirements.push("State expressly that TPR's regulatory investigation, enforcement, penalties or funding powers do not ordinarily determine an individual's complaint or award compensation to that member. Identify the scheme's Internal Dispute Resolution Procedure (IDRP), The Pensions Ombudsman (TPO), court or another redress route according to the claim. Use those exact body names and do not invent acronym expansions. Do not describe a civil penalty as compensation payable to the member.");
  }
  if (/\b(?:fraud|scam)\b/i.test(text) && /\bIDRP\b/i.test(text)) {
    requirements.push("Lead with a stop-transfer, stop-payment and stop-contact warning. Explain that urgent fraud or security reporting does not wait for IDRP, while IDRP/TPO is a separate complaint or redress route. Do not call TPO the PPF Ombudsman or require the fraud investigation to finish first.");
  }
  if (/\bFCA[- ]regulated adviser\b/i.test(text) && /\boccupational[- ]scheme administrator\b/i.test(text) && /\b(?:FOS|TPO)\b/i.test(text)) {
    requirements.push("Split the complaints by respondent and subject. A complaint about an FCA-regulated adviser's personal-pension investment recommendation may fall to the Financial Ombudsman Service (FOS), normally after the firm's complaints process. A complaint about delay or maladministration by an occupational-scheme administrator may fall to The Pensions Ombudsman (TPO), normally after the relevant scheme or respondent complaint process. Explain that overlap, permissions, time limits and the exact respondent may require referral or coordination. Expand TPO only as The Pensions Ombudsman and never as Transfer Pricing Office.");
  }
  if (/\bPension Schemes Act 2026\b|\bVirgin Media\b/i.test(text)) {
    requirements.push("Separate enactment from commencement as at the question's date. Name the exact Act, Part or section supporting the status and identify any operative regulations or later implementation still required; do not infer that every framework in the Act is already operative.");
  }
  if (/\bVirgin Media\b|\bsection 37 certificate\b/i.test(text)) {
    requirements.push("State that the Chapter 1 Part 4 remediation route is in force from Royal Assent. For a potentially remediable alteration, state that trustees request the scheme actuary's written confirmation that it is reasonable to conclude the alteration would not have prevented continued satisfaction of the contemporaneous statutory standard, subject to statutory scope and exclusions.");
  }
  if (/\bnew statutory override\b|\bsurplus power\b/i.test(text)) {
    requirements.push("The new statutory DB surplus override is not operative on 28 August 2026; TPR expects commencement in April 2027. Later regulations and guidance must set the conditions and process, and trustees must still check scheme power, funding evidence, member interests and advice.");
  }
  if (/\bdormant £?900 pots?\b|\bsmall.pot consolidation\b/i.test(text)) {
    requirements.push("Answer in no more than 120 words. The Act creates the small-pots framework and regulation-making powers but does not itself authorise automatic transfer of every dormant £900 pot next week. Do not make a contradictory commencement assertion. Regulations must define qualifying pots, dormancy, exemptions, authorised destinations or consolidator authorisation, notices, member safeguards, process and commencement.");
  }
  if (/\bdefault retirement.income solution\b|\bguided retirement\b/i.test(text)) {
    requirements.push("The Act creates the guided-retirement or default-pension framework, but an operative solution still depends on commencement, regulations, corresponding FCA rules, scheme design, communications and implementation; do not say it is already available.");
  }
  if (/\bnamed superfund\b/i.test(text)) {
    requirements.push("The Act creates an authorisation, supervision and individual-transfer approval framework, but it does not automatically authorise a named superfund or make a transfer suitable. Require TPR authorisation and approval plus transaction-specific covenant, funding, member-interest and legal advice.");
  }
  if (/(?:\b21 September 2024\b[^.]{0,100}\b22 September 2024\b|\b21 and 22 September 2024\b)/i.test(text) && /\b(?:funding code|valuation)\b/i.test(text)) {
    requirements.push("The pre-2024 DB funding code applies to a valuation effective on 21 September 2024. The 2024 DB Funding Code applies to a valuation effective on 22 September 2024. State the two results separately, then explain Scheme B's funding and investment strategy and chair-signed statement of strategy. Do not collapse the two dates into the same side of the transition.");
  }
  else if (/\b22 September 2024\b/i.test(text) && /\b(?:funding code|valuation|technical.provisions deficit|recovery plan)\b/i.test(text)) {
    requirements.push("In no more than 140 words: the 2024 DB funding regime and Code apply to the 22 September 2024 valuation. Address the funding and investment strategy, employer covenant and the rule that the recovery plan should eliminate the deficit as soon as the employer can reasonably afford; test the stated £8m affordability, proposed £3m contributions and ten-year term against evidence rather than assuming either figure is conclusive.");
  }
  if (/\bdashboards?\b/i.test(text) && /\brelevant members?|100|pensioner\b/i.test(text)) {
    requirements.push("The GB Regulations apply where the scheme had at least 100 relevant members at the reference date. Relevant members are active, deferred and pension-credit members. Apply those categories and figures explicitly and state whether pensioner members count: they do not.");
  }
  if (/\btrustee(?:'s)?\b/i.test(text) && /\b(?:spouse|business partner|bidding|conflict)\b/i.test(text)) {
    requirements.push("Apply conflict-management duties to the decision process: distinguish disclosure from effective management, address recusal or an independent decision process, and record reasons. Do not substitute an unrelated statutory definition of an independent trustee.");
  }
  if (/\b(?:dashboard (?:displays|calls|labels)|cash[- ]balance|collective money purchase|\bCDC\b|master trust|group personal pension|guaranteed annuity rate|final.salary section|money.purchase section|State Pension forecast)\b/i.test(text)) {
    requirements.push("Classify the legal arrangement and each benefit separately from the governing promise, instrument and legislation. Treat a dashboard or workplace label as evidence to verify, not as conclusive classification, and identify any guarantee or safeguarded feature separately.");
  }
  if (/\bfinal.salary section\b/i.test(text) && /\bmoney.purchase section\b/i.test(text) && /\btransfer question\b/i.test(text)) {
    requirements.push("Answer in no more than 100 words. Classify the particular rights being transferred and the section in which they arise, not the scheme's overall label. Explain that final-salary and money-purchase sections may engage different valuation, transfer and advice rules, including safeguarded-benefit checks. Do not state that independent-advice or safeguarded-benefit protection applies universally or automatically to both sections.");
  }
  if (/\bcouncil\b/i.test(text) && /\bworkplace DC\b/i.test(text)) {
    requirements.push("Answer in no more than 110 words. A dashboard label cannot conclusively classify the council pension. Check the statutory scheme regulations, administering authority, membership and service dates, and any separate AVC or section before deciding whether each benefit is DB, DC or mixed.");
  }
  if (/\bState Pension forecast\b/i.test(text)) {
    requirements.push("State expressly that State Pension is a statutory government benefit based on the National Insurance record, not a trust-based occupational scheme with trustees or an ordinary CETV. Analyse the occupational pension separately under its own rules and transfer regime.");
  }
  if (/\bguaranteed capital (?:amount|sum)\b/i.test(text)) {
    requirements.push("A guaranteed capital amount can be a cash-balance benefit: the promise is an amount rather than a benefit determined solely by investment performance. Confirm the guarantee and calculation in the governing rules; do not say cash balance ordinarily requires a salary-based pension.");
  }
  if (/\b(?:CDC authorisation|collective adjustment|target benefits).*\b(?:no individual pot|no employer guarantee)\b/i.test(text)) {
    requirements.push("Classify the authorised design as collective money purchase or CDC, not generic individual DC: target benefits may be adjusted collectively, there is no individual pot and the employer does not guarantee the benefit. Confirm the authorisation and governing rules.");
  }
  if (/\bmaster trust\b/i.test(text) && /\bindividual pot\b/i.test(text)) {
    requirements.push("State that an individual pot determined by contributions and investment returns is a money-purchase or defined-contribution benefit. The master-trust structure does not make that benefit defined benefit.");
  }
  if (/\bguarantee(?:d|s)? (?:an? )?annuity rate\b|\bguaranteed annuity rate\b/i.test(text)) {
    requirements.push("Treat the invested fund as money purchase while identifying the guaranteed annuity rate separately as a safeguarded feature or safeguarded benefit. Explain that its terms and value must be checked separately and that a transfer may trigger the statutory safeguarded-benefit advice protection.");
  }
  if (/\bpublic[- ]service pension\b/i.test(text) && /\bestablished by regulations\b/i.test(text)) {
    requirements.push("A statutory public-service scheme is governed by its establishing legislation and scheme regulations. Do not apply ordinary private-trust assumptions automatically; use a trust principle only where the statutory framework or another valid governing instrument makes it relevant.");
  }
  if (/\b(?:broad amendment power|delegated investment|rely on an adviser|chair made|missed all training|summary that omits|cannot produce minutes|deleting individual benefit|seven.year period)\b/i.test(text)) {
    requirements.push("Identify the authorised decision-maker, governing power, continuing trustee responsibility, required evidence and decision record. Do not treat delegation, advice, appointment, a summary communication or a generic retention period as displacing the governing rules and trustee judgment.");
  }
  if (/\bmissed all training\b/i.test(text)) {
    requirements.push("Appointment alone does not establish the statutory knowledge and understanding needed for the complex decision. Assess the trustee's actual knowledge, training and access to advice, address the gap, and ensure the board is properly informed before deciding.");
  }
  if (/\b(?:deleting individual benefit|generic seven.year period)\b/i.test(text)) {
    requirements.push("A generic seven-year period does not justify deleting records needed for deferred benefits that remain payable or an open complaint. Balance data minimisation against legal, limitation, litigation-hold and evidential needs, preserve an adequate benefit history and document the retention decision.");
  }
  if (/\bsummary\b/i.test(text) && /\b(?:omits|restriction|executed rules)\b/i.test(text)) {
    requirements.push("In no more than 110 words, state expressly that the summary does not amend or override the executed governing rules and cannot safely determine entitlement. Preserve it as evidence relevant to misleading communication, maladministration, reliance and possible remedy while checking the complete rule and amendment history; use the words maladministration, reliance and remedy.");
  }
  if (/\b(?:cannot produce|missing) minutes?\b/i.test(text) && /\bill[- ]health\b/i.test(text)) {
    requirements.push("In no more than 120 words, say expressly that missing minutes weaken evidence that the authorised decision-maker applied the ill-health rule, considered relevant evidence and gave adequate reasons, but do not automatically invalidate or validate the outcome. Reconstruct the audit trail without inventing reasons, preserve evidence and consider IDRP or scheme-specific legal review.");
  }
  if (/\b(?:employer shares|employer-owned residential property|employer securities|loan to the employer)\b/i.test(text)) {
    requirements.push("Distinguish the aggregate five per cent employer-related-investment ceiling from separately prohibited forms, including a direct loan to the employer, and apply the trustee's independent prudent process.");
  }
  if (/\b4%/i.test(text) && /\bemployer securities\b/i.test(text)) {
    requirements.push("Answer in no more than 100 words and apply both figures expressly: four per cent in employer securities is below but still tested against the five per cent aggregate ceiling and requires a prudent conflict-managed process; the separate direct employer loan remains prohibited regardless of percentage.");
  }
  if (/\bcyber incident\b/i.test(text)) {
    requirements.push("Begin by saying 'Contain and investigate the incident, protect payroll and member data, and preserve evidence.' In no more than 140 words, then separate internal controls and continuity, TPR breach-of-law materiality, UK GDPR personal-data-breach risk and ICO timing, and accurate member communications. State that one report does not satisfy every route.");
  }
  if (/\b(?:climate risk|liabilities or liquidity|liabilities and liquidity)\b/i.test(text)) {
    requirements.push("Assess liabilities, liquidity, diversification, financially material risks and appropriate advice together; considering climate risk alone is not a complete investment process.");
  }
  if (/\b(?:ESOG|own risk assessment|\bORA\b).*\b(?:120|100)\b/i.test(text)) {
    requirements.push("State the 100-member threshold and the ORA requirement. Explain that proportionality changes the assessment's depth, not whether this 120-member scheme must perform it.");
  }
  if (/\b(?:member booklet|scheme booklet|member newsletter|newsletter)\b/i.test(text) && /\b(?:executed )?scheme rules?\b/i.test(text)) {
    requirements.push("Identify the conflict, dates, versions and status of both documents. Do not silently choose a winner. State that executed current scheme rules generally carry greater weight for scheme terms, subject to law and any separate representation or estoppel issue. Refer the conflict for human legal or administrator review.");
  }
  if (/\b(?:PPF|Pension Protection Fund)\b/i.test(text) && /\b(?:increase|indexation|pre-?97|pre-?1997|before April 1997)\b/i.test(text)) {
    requirements.push("Use current PPF operational guidance to distinguish pre-97 and later service. State that original scheme pension rules before PPF entry are not the same as PPF compensation rules. The 2026 change allows future pre-1997 increases, generally capped at 2.5%, only where the original scheme provided mandatory or statutory pre-1997 increases; it does not provide back payments. Ask for the original scheme's mandatory-increase rule and service dates before confirming eligibility or a first payment date.");
  }
  if (/\b(?:technical.provisions deficit|actuarial valuation shows a deficit|recovery plan|schedule of contributions|section 75|contribution notice|clearance|notifiable.event|large dividend|enters administration|multi.employer scheme)\b/i.test(text)) {
    requirements.push("Distinguish the statutory trigger or duty from facts that merely require investigation. State the evidence, timing, exceptions, covenant or affordability analysis and escalation needed before predicting debt, breach, regulatory action or PPF entry.");
  }
  if (/\bpaid less than the schedule of contributions requires\b/i.test(text)) {
    requirements.push("Begin with 'This is an unpaid scheduled-contribution issue, not a section 75 test.' Identify the certified schedule, required amount, due date, explanation for non-payment and whether the shortfall is material or reportable. Trustees should pursue recovery and consider breach reporting and TPR powers under the applicable contribution process; do not invent a grace period or enforcement outcome. Do not discuss a scheme-funding deficit. Answer in no more than 120 words.");
  }
  if (/\bsell its most profitable subsidiary\b/i.test(text)) {
    requirements.push("Do not decide material detriment from the sale fact alone. Require evidence of the employer covenant, transaction value and destination of proceeds, mitigation, scheme funding and the counterfactual effect, then escalate transaction-specific legal, actuarial and covenant analysis.");
  }
  if (/\bmoved assets away\b/i.test(text) && /\bcontribution notice\b/i.test(text)) {
    requirements.push("Before discussing a contribution notice, establish the act or failure, timing, target person's connection, statutory purpose/effect tests including employer insolvency, employer resources or material detriment, available statutory defences, and whether imposing a notice would be reasonable. Do not substitute section 75 debt or predict TPR's discretion.");
  }
  if (/\bgranted security\b/i.test(text) && /\bmaterial business\b/i.test(text)) {
    requirements.push("In no more than 140 words, analyse the grant of security and proposed material business sale separately. Establish scheme and employer scope, transaction stage, decision or agreement date, thresholds and exceptions, then verify which notifiable-event and accompanying-statement provisions were actually in force on 10 August 2026 before stating any duty or deadline. Do not classify either fact as a notifiable event merely because it appeared in an uncommenced proposal.");
  }
  if (/\benters administration\b/i.test(text)) {
    requirements.push("In no more than 120 words, state expressly that administration may be a qualifying insolvency event and can start a PPF assessment period, but the PPF does not automatically assume responsibility. Check scheme eligibility, insolvency notices, the funding determination and assessment outcome; section 75 employer-debt issues remain relevant.");
  }
  if (/\bBelfast employer exits a multi.employer scheme\b/i.test(text)) {
    requirements.push("Answer in no more than 110 words. Do not apply the Great Britain employer-debt regulations as the governing instrument. Retrieve and apply the Northern Ireland counterpart, then check scheme connection, the statutory trigger, exceptions or arrangements and the prescribed valuation basis. Do not invent the outcome of those checks.");
  }
  if (/\blarge dividend\b/i.test(text) && /\bextending deficit contributions\b/i.test(text)) {
    requirements.push("Begin with 'The dividend does not automatically prove a breach and is not a section 75 trigger.' Treat it as relevant employer-covenant and reasonable-affordability evidence. Compare shareholder distributions, available cash, scheme needs, mitigation, decision timing and reporting duties under the applicable funding regime. Do not discuss a section 75 debt. Answer in no more than 110 words.");
  }
  if (/\bcease participation in a multi.employer DB scheme\b/i.test(text)) {
    requirements.push("Cessation after a reorganisation does not alone confirm a section 75 debt or amount. Check whether an employment-cessation or other statutory event occurred, whether active members remain, statutory exceptions or apportionment arrangements, timing and the prescribed buy-out-basis valuation before concluding. Answer in no more than 130 words.");
  }
  if (/\b(?:distinct roles|funding and investment strategy and the statement of strategy)\b/i.test(text)) {
    requirements.push("Distinguish the funding and investment strategy as the trustees' long-term strategy for benefits and planned asset allocation at the relevant date from the chair-signed statement of strategy, which records that strategy plus prescribed supplementary matters and is submitted with the valuation.");
  }
  if (/\bchair made a discretionary death.benefit decision alone\b/i.test(text)) {
    requirements.push("Answer in no more than 110 words and include every check: a chair acting alone cannot be assumed to exercise a discretion assigned by the rules to the trustee board; check delegation powers, quorum, possible ratification, conflicts, evidence and the actual decision record, and seek scheme-specific legal review before treating it as valid. Do not invent an emergency exception.");
  }
  if (/\bsignificantly mature\b/i.test(text) && /\bhigh investment risk\b/i.test(text)) {
    requirements.push("At significant maturity the strategy must target low dependency on employer support and a low-dependency investment allocation at the relevant date. High risk is not automatically forbidden today, but the journey plan, covenant reliability and supporting evidence must show how the objective will be met and risks supported.");
  }
  if (/\b(?:Walker v Innospec|same.sex.*survivor|GMP.*equal|civil partner|part.time|age.based|below a stated age|cohabitation|reasonable adjustments?|accessible format|gender marker|McCloud|remedial pension savings statement)\b/i.test(text)) {
    requirements.push("Apply the correct comparator, service period, operative equality rule and any objective-justification or reasonable-adjustment test. Do not infer entitlement or discrimination from status alone, and keep Great Britain and Northern Ireland authority separate.");
  }
  if (/\bdisabled member\b/i.test(text) && /\baccessible format\b/i.test(text)) {
    requirements.push("A standard portal does not end the duty to consider reasonable adjustments. Assess disability and substantial disadvantage, practicable accessible alternatives, cost and resources, and provide an effective alternative unless refusal is objectively supportable.");
  }
  if (/\bcivil partner\b/i.test(text) && /\bsurvivor pension\b/i.test(text)) {
    requirements.push("Compare the civil partner with the relevant opposite-sex spouse under the current equality rule. Check relationship, accrual and payment dates, historic exclusions, scheme amendments and controlling case law before limiting service or promising the result.");
  }
  if (/\bpart.time worker\b/i.test(text) && /\bpre.2000 service\b/i.test(text)) {
    requirements.push("Say expressly that today's rules alone cannot decide exclusion of historical part-time service. Check contemporaneous eligibility and employment facts, sex and comparator evidence, applicable EU-derived and domestic law, claim timing and remedy limits for each service period.");
  }
  if (/\bwomen's and men's pensions\b/i.test(text) && /\bdifferent retirement ages\b/i.test(text)) {
    requirements.push("Use the exact temporal analysis: identify service before and after 17 May 1990, the scheme's effective equalisation date and any Barber-window service. Apply the sex-equality rule, governing amendments and relevant case law to each service period; today's pension age does not resolve the historic calculation.");
  }
  if (/\benhanced early.retirement window\b/i.test(text) && /\bover 55\b/i.test(text)) {
    requirements.push("Do not mention the under-18 rule or section 28. State that an age threshold is not automatically unlawful only because direct age discrimination may be justified by a legitimate aim pursued through proportionate means. Require evidence of the aim, impact, alternatives and consistency, and check the scheme rules and any specific pension exception. Answer in no more than 120 words.");
  }
  if (/\btelephone evidence only\b/i.test(text)) {
    requirements.push("Consider whether telephone-only evidence substantially disadvantages the member and what reasonable adjustments or alternative evidence routes are practicable. Apply the ill-health rule fairly, obtain relevant evidence and record reasons; disability law does not guarantee the benefit outcome.");
  }
  if (/\bclosed a scheme only to workers below\b/i.test(text)) {
    requirements.push("Identify the age rule, affected workers, comparator and legitimate aim, then require evidence of impact and less discriminatory alternatives before deciding whether the measure is a proportionate means of achieving that aim.");
  }
  if (/\btransgender member\b/i.test(text) && /\bprevious name|gender marker\b/i.test(text)) {
    requirements.push("Answer in no more than 130 words. Correct and reconcile the service and benefit record so the name or gender-marker change does not split or reduce entitlement. Apply accuracy, necessity, data minimisation, confidentiality and access controls to historic identity data, preserve lawful evidence and avoid less favourable treatment.");
  }
  if (/\bBelfast part.time worker\b/i.test(text)) {
    requirements.push("State expressly that the Equality Act 2010 is generally a Great Britain instrument and must not be assumed to govern Northern Ireland service. Apply the Northern Ireland equality and part-time-worker legislation and identify the correct NI institutions after checking employment location and dates.");
  }
  if (/\bremedial pension savings statement\b/i.test(text)) {
    requirements.push("Begin with the exact words 'Use the remedial pension savings statement (RPSS)'. Answer in no more than 110 words as prose without a numbered list or any monetary amount or threshold. Compare corrected pension input amounts and recalculate affected annual-allowance positions for the relevant historic tax years under HMRC's McCloud process. Check prior charges, deadlines, refunds or compensation and whether a mandatory or voluntary scheme-pays election must be made, varied or reduced.");
  }
  if (/\b(?:28 February 2026|31 October 2026)\b/i.test(text)) {
    requirements.push("State that 28 February 2026 is the DWP staged connect-by guidance date for the stated cohort and 31 October 2026 is the statutory connection deadline; address the delay rather than treating the long-stop as erasing it.");
  }
  if ((/\bdashboards?\b/i.test(text) || /\bconnected only its DB section\b/i.test(text)) && /\b(?:AVC|possible match|view data|value data|outsourc)\b/i.test(text)) {
    requirements.push("Apply the dashboard duty to every relevant membership, matching state and value-data obligation in issue, and state that trustees or scheme managers remain accountable when operations are outsourced.");
  }
  if (/\bconnected only its DB section\b/i.test(text) && /\bAVC memberships\b/i.test(text)) {
    requirements.push("State expressly that dashboard connection and information duties apply across all relevant memberships and benefits in every section, including the money-purchase AVCs. Connecting only the DB section is incomplete; coordinate each provider, connect omitted AVC records promptly and use the correct value-data methodology for each benefit type.");
  }
  if (/\bpossible match\b/i.test(text) && /\bview data\b/i.test(text)) {
    requirements.push("Treat the record as a possible match, provide only the limited permitted administrative data and do not return view data until identity and consent resolve it to a match made. Apply documented matching criteria, records, UK GDPR security, minimisation and DPIA controls.");
  }
  if (/\bvalue data\b/i.test(text) && /\b2022|newer annual benefit statement\b/i.test(text)) {
    requirements.push("Provide accurate value data within the regulatory timescales using the applicable benefit methodology and an appropriate illustration date. Treat the newer statement as evidence that the 2022 value may be stale; verify, recalculate or explain and remedy delay.");
  }
  if (/\boutsourced every dashboards function\b/i.test(text)) {
    requirements.push("State expressly that trustees or scheme managers remain ultimately accountable despite outsourcing to an administrator or connection provider. Require contractual allocation, oversight, monitoring, data quality, reporting and remediation.");
  }
  if (/\bturns? 57 on 10 May 2028\b/i.test(text) && /\b6 April 2028\b/i.test(text)) {
    requirements.push("Apply the dates, not just the age labels: on 6 April 2028 this member is 56 and does not turn 57 until 10 May 2028. With no protected pension age, ordinary age-based access on 6 April is not authorised. Do not say the member has already reached 57.");
  }
  if (/\bstandard annual allowance, MPAA, threshold.income limit, adjusted.income limit, minimum tapered allowance and standard alternative annual allowance\b/i.test(text)) {
    requirements.push("Give all six 2026/27 figures expressly: standard annual allowance £60,000; MPAA £10,000; threshold-income limit £200,000; adjusted-income limit £260,000; minimum tapered annual allowance £10,000; standard alternative annual allowance £50,000, subject to taper.");
  }
  if (/\bused £20,000 of annual allowance in 2023\/24\b/i.test(text) && /£90,000 pension input in 2026\/27\b/i.test(text)) {
    requirements.push("Show the calculation: unused allowances are £40,000, £30,000 and £10,000, totalling £80,000 carry forward. Current £60,000 plus £30,000 carry forward covers £90,000, so the amount above the available allowance is nil.");
  }
  if (/\baccrued annual pension increased from £24,000 to £27,500\b/i.test(text)) {
    requirements.push("Use the supplied 16 factor and 3.8% opening CPI adjustment: opening £24,000 × 16 × 1.038 = £398,592; closing £27,500 × 16 = £440,000; pension input amount £41,408, assuming no separate lump sum or other adjustment.");
  }
  if (/\bScottish taxpayer\b/i.test(text) && /£42,000/i.test(text) && /£12,000 taxable pension withdrawal/i.test(text)) {
    requirements.push("Calculate annual non-savings Income Tax from the supplied 2026/27 bands: £54,000 income less £12,570 allowance gives £41,430 taxable; band tax is £753.73 + £2,597.80 + £2,968.56 + £4,341.96 = £10,662.05. Explain that actual cumulative PAYE depends on pay periods, prior pay and tax, payroll data and code operation.");
  }
  if (/\bPCLS-only flexi-access designation\b/i.test(text) && /\bqualifying small-pot lump sum\b/i.test(text)) {
    requirements.push("Classify each event: PCLS-only designation does not trigger; later taxable drawdown does; UFPLS generally does; a qualifying small-pot lump sum does not; a conventional non-flexible lifetime annuity generally does not.");
  }
  if (/\bcontributes £14,000 to DC\b/i.test(text) && /£46,000 of DB pension input\b/i.test(text)) {
    requirements.push("Apply the two tests separately: £14,000 DC exceeds the £10,000 MPAA by £4,000; £46,000 DB input is within the standard £50,000 alternative annual allowance, so there is no DB excess on the stated assumptions.");
  }
  if (/\bEEA QROPS occurred on 15 November 2024\b/i.test(text)) {
    requirements.push("State that the general EEA/Gibraltar exclusion was removed for transfers on or after 30 October 2024. With different member and scheme countries and no other exclusion, the 25% overseas transfer charge applies to the chargeable transfer, subject also to the overseas transfer allowance.");
  }
  if (/\bused 40% of the former lifetime allowance\b/i.test(text)) {
    requirements.push("Apply the default transition: 40% of the standard £1,073,100 former lifetime allowance is £429,240; deemed prior tax-free use is 25%, or £107,310. Deducting that from the £268,275 standard lump sum allowance leaves £160,965, unless a valid transitional tax-free amount certificate proves another amount.");
  }
  if (/\bdesignated £100,000 to flexi-access drawdown\b/i.test(text) && /\b1 September 2026\b/i.test(text)) {
    requirements.push("State that the 1 June PCLS-only designation with no taxable income did not trigger the MPAA. The £1,000 taxable drawdown income on 1 September 2026 was the trigger and fixes the trigger date.");
  }
  if (/£8,000 net by card on 4 April 2026\b/i.test(text)) {
    requirements.push("Allocate the relief-at-source member contribution to 2025/26 because the provider received the net payment on 4 April 2026; the later gross credit does not move it to 2026/27. Explain that an employer contribution uses its actual payment date and is not grossed under relief at source.");
  }
  if (/\bone £18,000 DB benefit\b/i.test(text) && /\btwo DC pots of £6,000 and £8,000\b/i.test(text)) {
    requirements.push("Distinguish the tests: each DC pot is individually below the £10,000 small-pot ceiling, subject to the other conditions. Trivial commutation aggregates the relevant £18,000 + £6,000 + £8,000 rights to £32,000, which exceeds the £30,000 threshold.");
  }
  if (/\b55-year-old became entitled to a scheme pension on 1 March 2028\b/i.test(text)) {
    requirements.push("State that the pre-6 April 2028 scheme-pension entitlement can continue after the NMPA increase under the transition. Distinguish any fresh crystallisation after 5 April 2028, which separately needs age 57, protection or another exception.");
  }
  if (/\bdies on 5 April 2027\b/i.test(text) && /\bpaid in May 2027\b/i.test(text)) {
    requirements.push("Use the death date: the new Finance Act 2026 pension-IHT inclusion applies to deaths on or after 6 April 2027, so a 5 April death is outside it even though payment occurs later.");
  }
  if (/\bdies on 6 April 2027\b/i.test(text) && /\bunused DC funds\b/i.test(text)) {
    requirements.push("State the enacted high-level rule: most unused DC funds are notional pension property within the estate calculation for a death on 6 April 2027, subject to exclusions and exemptions. Keep final forms, information fields, deadlines, withholding and payment mechanics conditional on operative secondary legislation and current HMRC guidance.");
  }
  if (/\bturn 56 in July 2029\b/i.test(text) && /\bdashboard says I can retire at 55\b/i.test(text)) {
    requirements.push("State that NMPA is 57 from 6 April 2028 and the dashboard's age 55 is not enough. Check scheme rules, membership date, an unqualified pre-4 November 2021 right, protection record, transfer history and any ill-health or uniformed-service exception.");
  }
  if (/\bdelay retirement beyond the scheme's normal pension age\b/i.test(text)) {
    requirements.push("State expressly that late retirement does not automatically increase every component. Apply the governing rules and separate treatment or factors for the main pension, GMP, AVCs and any underpin; do not promise an actuarial uplift.");
  }
  if (/\bexpression.of.wish form names my daughter\b/i.test(text)) {
    requirements.push("Use the word 'discretion': the form is relevant but not a guarantee where the rules confer trustee or administrator discretion. The proper decision-maker must apply the rules, consider the current beneficiary class and relevant circumstances, manage conflicts and record reasons. Cite only an identifier present in the verified sources.");
  }
  if (/\bcalculate the best commutation choice\b/i.test(text)) {
    requirements.push("Do not call an option 'best'. The dashboard may show factual values only after the quote, commutation factor, tax limits and effects on every component are known. A personal recommendation needs the member's objectives and appropriately authorised advice.");
  }
  if (/\blabelled eligible for trivial commutation\b/i.test(text)) {
    requirements.push("The label is not proof. Check age, aggregate relevant rights, the £30,000 limit, commutation period, prior payments, extinguishment conditions and scheme power, and keep the separate £10,000 small-pot route distinct.");
  }
  if (/\b63-year-old member\b/i.test(text) && /\blife expectancy is eight months\b/i.test(text)) {
    requirements.push("Do not mention the £268,275 lump sum allowance: it is the wrong allowance for this case. Apply every serious-ill-health condition: acceptable medical evidence of life expectancy under one year, uncrystallised rights, scheme power and extinguishment of the relevant entitlement. State that age 63 is under 75. Test £180,000 against the remaining £1,073,100 standard lump sum and death benefit allowance (LSDBA); only an excess over available LSDBA is generally exposed to Income Tax. Cite verified evidence for both the payment conditions and LSDBA.");
  }
  if (/\bretirement quote excludes an AVC account\b/i.test(text)) {
    requirements.push("Do not automatically combine or omit the AVC. Establish whether it is a separate arrangement, its retirement and election rules, tax treatment, valuation date, and whether it may or must be taken with the main benefit before presenting a consolidated total.");
  }
  if (/\bdashboard uses the unreduced normal.retirement figure\b/i.test(text)) {
    requirements.push("Explain the actual reduced early-retirement pension in payment as the current payable benefit, with reduction and effective date. The unreduced normal-retirement amount may appear only as a clearly labelled comparator or projection, never as the payable value. Cite only verified identifiers.");
  }
  if (/\bcaller offers pension access\b/i.test(text) && /\bloan arrangement\b/i.test(text)) {
    requirements.push("Say this is not an ordinary retirement option absent a statutory exception. Warn about unauthorised-payment tax charges and scam risk, do not facilitate it, and direct the user to independent verification and official reporting routes.");
  }
  if (/\bscheme rules on 11 February 2021\b/i.test(text) && /\baccess in 2029\b/i.test(text)) {
    requirements.push("List every required check expressly: the stated pre-4 November 2021 scheme rules and joining date; the unqualified age-55 right; amendments; administrator protection record; every individual transfer; every block transfer; any winding-up event; and any separation of rights. Explain that the statutory transfer conditions determine whether protection follows the transferred rights.");
  }
  if (/\b70-year-old\b/i.test(text) && /\bnine-month life expectancy\b/i.test(text)) {
    requirements.push("Begin 'At age 70'. Do not mention the £268,275 lump sum allowance: it is the wrong allowance for this case. Apply the facts: the nine-month prognosis satisfies the under-one-year condition subject to acceptable evidence; rights are uncrystallised and scheme power exists. Test £120,000 against the remaining £1,073,100 standard lump sum and death benefit allowance (LSDBA); with no prior usage it is within LSDBA, and only an excess is taxed. Cite verified evidence for both the payment conditions and LSDBA.");
  }
  if (/\bthreshold income and adjusted income are both unknown\b/i.test(text)) {
    requirements.push("Salary alone is insufficient. For 2026/27 obtain statutory threshold income and adjusted income, including the relevant pension-contribution adjustments. The taper thresholds are £200,000 threshold income and £260,000 adjusted income; do not use the superseded £110,000 and £150,000 figures.");
  }
  if (/\bunused allowance in earlier years\b/i.test(text) && /\bcomplete pension.input records\b/i.test(text)) {
    requirements.push("Do not calculate carry forward without current-year and previous-three-tax-year pension input amounts. Confirm registered-scheme membership and the allowance, taper or MPAA position for each year; use the current year's allowance first and then the oldest available unused amount.");
  }
  if (/\bdashboard shows the standard lump sum allowance\b/i.test(text)) {
    requirements.push("State the £268,275 standard amount but explain that it does not prove availability. Check every pre- and post-6 April 2024 benefit event, statutory conversion of former lifetime-allowance usage, protection and any transitional tax-free amount certificate.");
  }
  if (/\bdeath-benefit payment may use the lump sum and death benefit allowance\b/i.test(text)) {
    requirements.push("In prose, check age at death, death date, payment type, timing and recipient, all prior lump-sum and death-benefit allowance usage, protection, remaining allowance and whether this is an allowance-using lump sum. Require the complete crystallisation and death-benefit history before confirming tax treatment.");
  }
  if (/\bold lifetime.allowance protection certificate\b/i.test(text)) {
    requirements.push("It cannot be ignored merely because the lifetime allowance charge was abolished. A valid protection may increase LSA or LSDBA; verify type, HMRC reference, loss conditions, prior events and any transitional tax-free amount certificate before calculating availability.");
  }
  if (/\bproposed transfer goes to an overseas pension arrangement\b/i.test(text)) {
    requirements.push("Name every required fact: transfer date, QROPS status, destination country, member residence, scheme country, statutory exclusions and remaining overseas transfer allowance. Then state that a non-exempt transfer or allowance excess can attract a 25% overseas transfer charge and that residence changes in the following five full tax years can matter. Do not replace these facts with a generic handoff.");
  }
  if (/£8,000 net by card on 4 April 2026\b/i.test(text)) {
    requirements.push("Allocate the relief-at-source contribution to 2025/26 because the provider received £8,000 on 4 April 2026; the later £10,000 gross credit does not move it. An employer contribution follows its actual payment date and is not grossed under relief at source.");
  }
  if (/\bemployer paid a large contribution directly to the scheme\b/i.test(text)) {
    requirements.push("Do not assume the same relief. Personal relief depends on relevant UK earnings and the relief method; employer deductibility follows the employer's wholly-and-exclusively and timing rules. Explain that both can still count for annual-allowance purposes where applicable.");
  }
  if (/\bannual allowance charge is £3,500\b/i.test(text)) {
    requirements.push("Distinguish mandatory scheme pays from a voluntary policy. Cover the statutory charge and scheme-input thresholds, a valid notice for the amount attributable to that scheme, the statutory deadline, and the voluntary policy's own terms; confirm tax year, scheme input, charge attribution, notice amount and amendment needs.");
  }
  return requirements;
}

function retrievalQuery(question) {
  const text = String(question || "").trim();
  if (/(?:\b21 September 2024\b[^.]{0,100}\b22 September 2024\b|\b21 and 22 September 2024\b)/i.test(text) && /\b(?:funding code|valuation)\b/i.test(text)) {
    return "The Pensions Regulator Defined Benefit Funding Code transition valuation effective date pre-2024 funding code applies 21 September 2024; Defined Benefit Funding Code 2024 applies 22 September 2024";
  }
  if (/\bFCA[- ]regulated adviser\b/i.test(text) && /\boccupational[- ]scheme administrator\b/i.test(text) && /\b(?:FOS|TPO)\b/i.test(text)) {
    return "Financial Ombudsman Service pensions annuities complaints FCA-regulated adviser personal pension investment advice formal complaint to business; The Pensions Ombudsman complaint administration of an occupational pension scheme actual or potential beneficiary sustained injustice maladministration act or omission of administrator transfer delay formal complaint process";
  }
  if (/\bfinal.salary section\b/i.test(text) && /\bmoney.purchase section\b/i.test(text) && /\btransfer question\b/i.test(text)) {
    return "Pension Schemes Act 1993 safeguarded benefits appropriate independent advice transfer final salary defined benefit money purchase section classify rights separately";
  }
  if (/\bchair made a discretionary death.benefit decision alone\b/i.test(text)) {
    return "The Pensions Regulator General Code governing body decision maker delegation quorum ratification conflicts decision records trustee board chair discretion scheme rules";
  }
  if (/\bpaid less than the schedule of contributions requires\b/i.test(text)) {
    return "Pensions Act 2004 schedule of contributions recovery by trustees unpaid employer contributions due date breach reporting The Pensions Regulator DB Funding Code";
  }
  if (/\blarge dividend\b/i.test(text) && /\bextending deficit contributions\b/i.test(text)) {
    return "The Pensions Regulator Defined Benefit Funding Code employer covenant reasonable affordability recovery plan dividends shareholder distributions mitigation available cash scheme needs";
  }
  if (/\b22 September 2024\b/i.test(text) && /\btechnical.provisions deficit\b/i.test(text) && /\brecovery plan\b/i.test(text)) {
    return "The Pensions Regulator Defined Benefit Funding Code 2024 recovery plan as soon as employer can reasonably afford employer covenant technical provisions funding and investment strategy valuation effective 22 September 2024";
  }
  if (/\bgranted security\b/i.test(text) && /\bmaterial business\b/i.test(text)) {
    return "Pensions Act 2004 section 69 notifiable events section 69A duty notices statements main terms proposed commencement prescribed events grant security sale material business current regulations in force";
  }
  if (/\bBelfast part.time worker\b/i.test(text)) {
    return "Occupational Pension Schemes Amendment Equal Treatment Northern Ireland Regulations 2023 Northern Ireland equality part-time worker legislation industrial tribunal territorial extent Equality Act 2010 Great Britain";
  }
  if (/\bremedial pension savings statement\b/i.test(text)) {
    return "HMRC Pensions Tax Manual remedial pension savings statement RPSS corrected pension input amount annual allowance tax charge scheme pays election compensation refund deadline McCloud remedy";
  }
  if (/\bnormal minimum pension age|protected pension age|\bNMPA\b/i.test(text)) {
    return `${text}\nAuthority routing terms: HMRC Pensions Tax Manual PTM028000 PTM062100 PTM062215 PTM062240 normal minimum pension age 57 from 6 April 2028 protected pension age unqualified right transfer transition newsletter 180`;
  }
  if (/\bsmall-pot|small pot|trivial commutation|serious ill-health lump sum\b/i.test(text)) {
    return `${text}\nAuthority routing terms: HMRC Pensions Tax Manual small pension payments £10,000 trivial commutation £30,000 aggregate serious ill-health lump sum life expectancy less than one year lump sum and death benefit allowance Finance Act 2004`;
  }
  if (/\bretirement quote excludes an AVC account\b/i.test(text)) {
    return `${text}\nAuthority routing terms: Pensions Dashboards Regulations 2022 all relevant memberships DB money purchase AVC value data accurate benefit components separate arrangement election rules retirement quote`;
  }
  if (/\b(?:expression.of.wish|commutation|late retirement|early.retirement pension|AVC account|unauthorised.*loan arrangement)\b/i.test(text)) {
    return `${text}\nAuthority routing terms: scheme rules retirement benefits HMRC Pensions Tax Manual authorised payments commutation death benefits trustee discretion actual payable pension projections unauthorised payment tax charge`;
  }
  if (/\b(?:overseas pension arrangement|EEA QROPS|overseas transfer charge)\b/i.test(text)) {
    return `${text}\nAuthority routing terms: HMRC Pensions Tax Manual QROPS overseas transfer charge 25% overseas transfer allowance member residence scheme country statutory exclusions five full tax years 30 October 2024 EEA Gibraltar`;
  }
  if (/£8,000 net by card on 4 April 2026\b/i.test(text)) {
    return `${text}\nAuthority routing terms: HMRC Pensions Tax Manual relief at source contribution payment date provider receives net payment tax year gross credit employer contribution actual payment date`;
  }
  if (/\bScottish taxpayer\b/i.test(text) && /£42,000/i.test(text) && /£12,000 taxable pension withdrawal/i.test(text)) {
    return `${text}\nAuthority routing terms: GOV.UK Income Tax rates and Personal Allowances current and past Scotland 2026 to 2027 personal allowance starter basic intermediate higher bands PAYE cumulative tax code`;
  }
  if (/\bannual allowance|\bMPAA\b|tapered annual allowance|pension input amount|scheme pays|lump sum allowance|overseas transfer charge|\bQROPS\b/i.test(text)) {
    return `${text}\nAuthority routing terms: HMRC Pensions Tax Manual 2026 2027 pension schemes rates standard annual allowance money purchase annual allowance tapered threshold adjusted income alternative annual allowance carry forward pension input scheme pays lump sum allowance overseas transfer charge`;
  }
  if (/\binheritance tax|\bIHT\b/i.test(text) && /\bpension|death benefit|unused funds\b/i.test(text)) {
    return `${text}\nAuthority routing terms: Finance Act 2026 Part 2 inheritance tax notional pension property death on or after 6 April 2027 HMRC Inheritance Tax on pensions technical note secondary legislation information sharing`;
  }
  const additions = [];
  if (/\bcash equivalent\b/i.test(text) && /\b(?:underfunded|underfunding|reduce|reduction|insufficien)/i.test(text)) {
    additions.push("Pension Schemes Act 1993 cash equivalent transfer value Occupational Pension Schemes Transfer Values Regulations 1996 insufficiency report actuarial valuation permitted reduction underfunded defined benefit scheme trustees");
  }
  if (/\bpension from an employer\b[^.!?]{0,80}\bmissing from (?:my |the )?dashboard\b/i.test(text)) {
    additions.push("Pensions Dashboards Regulations 2022 find request matching possible match scheme connection value data GOV.UK Pension Tracing Service former employer pension contact scheme");
  }
  if (/\bpension under an employer i have never worked for\b|\bpossible false match\b/i.test(text)) {
    additions.push("Pensions Dashboards Regulations 2022 regulation 23 find request matching possible match view data Information Commissioner UK GDPR accuracy data minimisation security personal data breach false match privacy incident");
  }
  if (/\b(?:statutory transfer|transfer request|transfer safeguards?|transfer conditions?)\b/i.test(text)
      || (/\btransfer\b/i.test(text) && /\bscheme\b/i.test(text) && /\b(?:overseas|Dublin|Belfast|cross.border)\b/i.test(text))) {
    additions.push("Occupational and Personal Pension Schemes Conditions for Transfers Regulations 2021 First Condition Second Condition statutory right to transfer The Pensions Regulator dealing with transfer requests");
    if (/\bconsultation|\bpropos/i.test(text)) additions.push("Department for Work and Pensions Protecting Pension Savers proposals to amend Conditions for Transfers Regulations consultation legal status commencement");
    if (/\boverseas|\bDublin|\bcross.border/i.test(text)) additions.push("HMRC overseas pension transfer QROPS tax jurisdiction receiving scheme destination country regulation");
  }
  if (/\bpossible match|\bmatching criteria|\bview data\b/i.test(text)) additions.push("Pensions Dashboards Regulations 2022 regulation 23 find requests matching pension identifiers view requests Information Commissioner UK GDPR data protection principles identity consent data minimisation security");
  if (/\bVirgin Media\b|\bsection 37 certificate\b/i.test(text)) additions.push("Pension Schemes Act 2026 Part 4 Chapter 1 sections 101 102 in force now Royal Assent statutory remediation introduced Virgin Media judgment written actuarial confirmation historic benefit changes met necessary standards potentially remediable alteration trustees request scheme actuary reasonable to conclude would not have prevented continued satisfaction statutory standard The Pensions Regulator");
  else if (/\bPension Schemes Act 2026\b/i.test(text)) additions.push("Pension Schemes Act 2026 section 133 commencement The Pensions Regulator implementation status");
  if ((/\bdashboards?\b/i.test(text) || /\bconnected only its DB section\b/i.test(text)) && /\b(?:connect|connected|relevant members?|100|pensioner|matching|possible match|view data|value data|AVC|all sections|outsourc|staged|28 February 2026|31 October 2026)\b/i.test(text)) additions.push("Pensions Dashboards Regulations 2022 relevant member definition all sections DB money purchase AVC memberships connection value data matching trustees managers");
  if (/\b(?:28 February 2026|31 October 2026|connect.by date|staged timetable)\b/i.test(text)) additions.push("DWP pensions dashboards guidance connection staged timetable 600 749 28 February 2026 statutory connection deadline 31 October 2026");
  if (((/\bdashboards?\b/i.test(text) || /\bconnected only its DB section\b/i.test(text)) && /\b(?:AVC|all sections|possible match|view data|value data|annual benefit statement|outsourc)\b/i.test(text)) || /\bvalue data\b|\bannual benefit statement\b/i.test(text)) additions.push("The Pensions Regulator dashboards guidance all relevant memberships AVC possible match view data value data accurate sufficiently recent annual benefit statement trustees remain accountable outsourcing");
  if (/\b(?:funding code|funding[- ]and[- ]investment[- ]strategy|statement[- ]of[- ]strategy|Fast Track|Bespoke|significantly mature|low dependency|technical.provisions deficit|recovery plan)\b/i.test(text)) additions.push("The Pensions Regulator Defined Benefit Funding Code 2024 valuation effective date 22 September 2024 technical provisions deficit reasonable affordability employer covenant recovery plan funding and investment strategy statement of strategy Part 1 Part 2 supplementary matters signed on behalf of trustees by chair submitted to Regulator");
  if (/\bemployer.related investment|employer securities|employer shares|employer-owned residential property|loan to the employer\b/i.test(text)) additions.push("Pensions Act 1995 section 40 Occupational Pension Schemes Investment Regulations 2005 employer-related investment employer shares residential property loan five per cent absolutely prohibited");
  if (/\bWalker v Innospec|same[- ]sex\b[^.!?]{0,100}\bsurvivor|survivor\b[^.!?]{0,100}\bsame[- ]sex/i.test(text)) additions.push("Walker v Innospec Limited and others 2017 UKSC 47 Equality Act 2010 Schedule 9 paragraph 18 18(1C) same-sex spouse civil partner survivor pension service dates statutory exception");
  if (/\b(?:women|men|sex equal|retirement ages?).*\b(?:equalis|service)\b/i.test(text)) additions.push("Barber v Guardian 17 May 1990 Coloroll equalisation date pension service");
  if (/\bMcCloud\b|\bremedial pension savings statement\b/i.test(text)) additions.push("Public Service Pensions and Judicial Offices Act 2022 remedy period 1 April 2015 31 March 2022 HMRC annual allowance remedial pension savings statement");
  if (/\b(?:cash[- ]balance|collective money purchase|\bCDC\b|master trust|group personal pension|individual investment account|occupational.*personal pension|personal pension.*occupational|safeguarded feature|guaranteed annuity rate|final.salary.*money.purchase|money.purchase.*final.salary)\b/i.test(text)) additions.push("Pension Schemes Act 1993 Pension Schemes Act 2015 definitions occupational pension personal pension defined benefits money purchase cash balance collective benefits safeguarded benefits");
  if (/\b(?:council pension|public[- ]service pension|local government pension|workplace DC)\b/i.test(text)) additions.push("public service pension statutory scheme regulations administering authority defined benefits money purchase AVC classification governing instrument");
  if (/\b(?:council|public[- ]service pension)\b/i.test(text)) additions.push("Public Service Pensions Act 2013 statutory scheme regulations administering authority occupational pension classification");
  if (/\bState Pension\b/i.test(text)) additions.push("Department for Work and Pensions Your State Pension explained regular payment from government National Insurance record Pensions Act 2014 not occupational pension scheme no trustees no cash equivalent transfer value");
  const specialistQuestion = /\b(?:Virgin Media|Pension Schemes Act 2026|dashboards?|funding code|funding and investment strategy|statement of strategy|Walker v Innospec|employer shares|employer-owned residential property|employer securities|loan to the employer)\b/i.test(text);
  if (!specialistQuestion && /\b(?:trustee|trustees|governing body|ESOG|own risk assessment|\bORA\b)\b/i.test(text)) additions.push("The Pensions Regulator General Code of Practice 2024 governing body effective system of governance own risk assessment delegation conflicts internal controls records knowledge and understanding");
  if (/\b(?:amendment power|accrued right|protected right|subsisting right)\b/i.test(text)) additions.push("Pensions Act 1995 section 67 subsisting rights scheme amendment power");
  if (/\b(?:investment management|investment process|liquidity|climate risk)\b/i.test(text)) additions.push("Occupational Pension Schemes Investment Regulations 2005 section 36 Pensions Act 1995 investment powers advice diversification liquidity");
  if (/\bsummary\b/i.test(text) && /\b(?:omits|restriction|executed rules)\b/i.test(text)) additions.push("The Pensions Regulator General Code of Practice member communications accurate clear not misleading governing rules maladministration reliance remedy Pensions Act 2004");
  if (/\b(?:cannot produce|missing) minutes?\b/i.test(text) && /\bill[- ]health\b/i.test(text)) additions.push("The Pensions Regulator General Code of Practice decision records minutes relevant evidence reasons audit trail IDRP ill-health discretion Pensions Act 2004");
  if (/\b(?:PPF|Pension Protection Fund)\b/i.test(text) && /\b(?:increase|indexation|pre-?97|pre-?1997|before April 1997|compensation payments?)\b/i.test(text)) {
    additions.push("Pension Protection Fund PPF information on pre-97 indexation Will my PPF payments increase Pension Schemes Act 2026 section 109 2.5 per cent original scheme mandatory statutory pre-1997 increases no back payments");
  }
  const ppfFundingContext = /\b(?:PPF|Pension Protection Fund)\b/i.test(text)
    && /\b(?:assessment period|assume responsibility|qualifying insolvency|employer debt|section 75|scheme funding|PPF entry)\b/i.test(text);
  if (ppfFundingContext || /\b(?:section 75|employer debt|contribution notice|clearance|notifiable event|employer covenant|corporate transaction|recovery plan|schedule of contributions|technical.provisions deficit|actuarial valuation shows a deficit|dividend|multi.employer.*(?:exit|cease)|sell its most profitable subsidiary|material business)\b/i.test(text)) {
    additions.push("Pensions Act 2004 scheme funding employer covenant contribution notice notifiable events Pension Protection Fund Pensions Act 1995 section 75 employer debt");
  }
  if (/\bsell its most profitable subsidiary\b/i.test(text)) additions.push("The Pensions Regulator DB Funding Code employer covenant transaction value proceeds mitigation counterfactual material detriment Pensions Act 2004");
  if (/\bmoved assets away\b/i.test(text) && /\bcontribution notice\b/i.test(text)) additions.push("Pensions Act 2004 contribution notice material detriment employer insolvency employer resources tests statutory defence reasonable target person connected associated");
  if (/\bgranted security\b/i.test(text) && /\bmaterial business\b/i.test(text)) additions.push("Pensions Act 2004 notifiable events grant security material business sale decision agreement accompanying statement commencement in force deadline 10 August 2026");
  if (/\benters administration\b/i.test(text)) additions.push("Pensions Act 2004 Pension Protection Fund qualifying insolvency event assessment period assume responsibility section 75 employer debt");
  if (/\bBelfast employer exits a multi.employer scheme\b/i.test(text)) additions.push("Northern Ireland Occupational Pension Schemes Employer Debt Regulations 2005 multi-employer employment cessation event exceptions apportionment valuation");
  if (/\b(?:disab(?:led|ility)|reasonable adjustment|age discrimination|age[- ]based|over 55|below a stated age|sex equality|civil partner|part[- ]time|gender reassignment)\b/i.test(text)) additions.push("Equality Act 2010 occupational pension scheme non-discrimination rule reasonable adjustments age legitimate aim objective justification proportionate means evidence alternatives survivor benefits");
  if (/\btransgender member\b|\bgender marker\b/i.test(text)) additions.push("Information Commissioner's Office UK GDPR data protection principles accuracy rectification data minimisation integrity confidentiality security access controls Equality Act 2010 gender reassignment");
  if (/\bremedial pension savings statement\b/i.test(text)) additions.push("HMRC Pensions Tax Manual McCloud remedial pension savings statement corrected pension input amount annual allowance tax charge scheme pays election compensation refund deadline");
  if (/\b(?:GMP.*equali[sz]|equali[sz]ation.*GMP)/i.test(text)) additions.push("Lloyds Banking Group Pensions Trustees GMP equalisation 2018 EWHC 2839 2020 EWHC 3135 lawful method transfer payments");
  if (/\b(?:cohabit|marital status|survivor.*nomination)\b/i.test(text)) additions.push("Equality Act 2010 occupational pension survivor benefit marital status comparator nomination dependency scheme rules");
  return additions.length ? `${text}\nAuthority routing terms: ${additions.join("; ")}` : text;
}

export function processQuery(question, context = {}) {
  const clean = String(question || "").trim();
  if (!clean) throw Object.assign(new Error("message is required"), { status: 400 });
  const routeDecision = responseRoute(clean);
  const entities = knownEntities(clean, context);
  let jurisdiction = normaliseJurisdiction(entities.jurisdiction);
  if (TAX_PATTERN.test(clean)) jurisdiction = "UK_TAX";
  if (jurisdiction === "ENGLAND_AND_WALES" && !/\b(?:divorc|pension sharing|pension attachment|earmarking|job\b.*\btransferr?ing|employment transfer|tupe)\b/i.test(clean)) jurisdiction = "GREAT_BRITAIN";
  if (jurisdiction !== "UNSPECIFIED") entities.jurisdiction = jurisdiction;

  const dashboardFactComparison = verifiedDashboardFactComparison(clean);
  const conflictingSchemeDocuments = routeDecision.reason === "conflicting_scheme_documents";
  const legalEvidenceRequired = pensionRuleQuestion(clean) && !dashboardFactComparison && !conflictingSchemeDocuments;
  let intent = detectIntent(clean, routeDecision.route);
  if (dashboardFactComparison) intent = "USER_PORTFOLIO";
  const explicitUserDocument = /\b(?:uploaded|attached|my (?:statement|document|letter|notice)|this (?:statement|document|letter|notice))\b/i.test(clean);
  const explicitPersonalEvidence = Boolean(entities.provider || entities.policyNumber || entities.accountId || PERSONAL_DATA_PATTERN.test(clean));
  if (legalEvidenceRequired && ["USER_DOCUMENT", "HYBRID"].includes(intent) && !explicitUserDocument && !explicitPersonalEvidence) intent = "PENSION_LAW";
  if (intent === "PENSION_LAW" && (entities.provider || entities.policyNumber || entities.accountId || PERSONAL_DATA_PATTERN.test(clean))) intent = "HYBRID";
  const publicEvidenceRequired = legalEvidenceRequired || PUBLIC_GUIDANCE_PATTERN.test(clean);
  const personalScope = PERSONAL_DATA_PATTERN.test(clean) || Boolean(entities.provider || entities.policyNumber || entities.accountId) || ["USER_PORTFOLIO", "PROJECTION", "HYBRID"].includes(intent);
  const documentScope = ["USER_DOCUMENT","HYBRID"].includes(intent) || (legalEvidenceRequired && personalScope) || routeDecision.route === "ANSWER_AND_HANDOFF" || /\b(?:uploaded|document|statement|letter|notice|pdf|scheme rules?)\b/i.test(clean);
  const sourceScopes = [];
  if (personalScope) sourceScopes.push("USER_PORTFOLIO");
  if (documentScope) sourceScopes.push("USER_DOCUMENTS");
  if (publicEvidenceRequired || intent === "GENERAL_PENSION_FAQ" || routeDecision.route === "SECURITY_FALLBACK") sourceScopes.push("CURATED_PUBLIC");
  if (!sourceScopes.length) sourceScopes.push("CURATED_PUBLIC");

  const structuredLookups = [];
  if (sourceScopes.includes("USER_PORTFOLIO")) structuredLookups.push("account", "charges", "document_status", ...(intent === "PROJECTION" ? ["projection"] : []), ...(/\b(invest|allocation|fund|risk)\b/i.test(clean) ? ["investment_profile"] : []));
  if (sourceScopes.includes("CURATED_PUBLIC") && TAX_PATTERN.test(clean)) structuredLookups.push("public_tax_facts");

  const accountAmbiguity = /\b(my (?:plan|account)|that (?:plan|account)|(?:first|second|third|last) one)\b/i.test(clean) && !entities.provider && (context.providers || []).length > 1;
  const jurisdictionAmbiguity = requiresJurisdictionClarification(clean, jurisdiction);
  return {
    intent:INTENTS.has(intent) ? intent : "GENERAL_PENSION_FAQ",
    response_route:RESPONSE_ROUTES.has(routeDecision.route) ? routeDecision.route : "ANSWER",
    handoff_reason:routeDecision.reason,
    self_contained_query:rewrite(clean, context, entities),
    retrieval_query:retrievalQuery(clean),
    entities,
    jurisdiction_scope:jurisdiction,
    retrieval_jurisdiction_scope:/\bGreat Britain\b/i.test(clean) && /\bNorthern Ireland\b/i.test(clean) ? "GB_AND_NI" : jurisdiction,
    source_scopes:[...new Set(sourceScopes)],
    structured_lookups:[...new Set(structuredLookups)],
    legal_evidence_required:legalEvidenceRequired,
    public_evidence_required:publicEvidenceRequired,
    freshness_required:publicEvidenceRequired,
    needs_clarification:accountAmbiguity || jurisdictionAmbiguity,
    clarification_reason:accountAmbiguity ? "account_ambiguity" : jurisdictionAmbiguity ? "jurisdiction_ambiguity" : null,
    clarification_prompt:jurisdictionAmbiguity ? jurisdictionClarificationPrompt(clean) : null,
    response_requirements:responseRequirements(clean)
  };
}
