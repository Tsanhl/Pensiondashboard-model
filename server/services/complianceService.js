import { createHash } from "node:crypto";
const ASSISTANT_PROMPT_VERSION = "pension-grounding-v1";
import {
  appendAuditEvent,
  dataPathsForUser,
  listKnownUsers,
  newId,
  readAssistantAnswerAudits,
  readAuditLog,
  readComplianceCases,
  readRiskProfile,
  storageStatus,
  writeAssistantAnswerAudits,
  writeComplianceCases
} from "../store/userDataStore.js";

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function highRiskPensionQuestion(text = "") {
  return /\b(transfer|consolidat|defined benefit|db scheme|guarantee|guaranteed annuity|protected pension age|exit charge|market value reduction|employer contribution|scheme-specific|move provider|switch provider|legal rights|can my employer)\b/i.test(String(text || ""));
}

function isoNow() {
  return new Date().toISOString();
}

export function complianceMetadata({ provider, model, usedSearch, currentSourceNote, agentSummary, riskProfile } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    adviceBoundary: "planning_support_not_regulated_financial_advice",
    allowed: [
      "explain_dashboard_numbers",
      "identify_review_routes",
      "suggest_questions_for_provider_or_adviser",
      "compare_risks_and_tradeoffs",
      "flag_missing_documents_or_data",
      "suggest_candidate_allocation_review_ranges",
      "give_source_checked_legal_route_guidance"
    ],
    blocked: [
      "move_money",
      "submit_forms",
      "execute_trades",
      "choose_final_fund_or_provider",
      "give_final_tax_or_legal_conclusion",
      "claim_100_percent_legal_accuracy_without_current_sources",
      "recommend_transfer_without_guarantee_and_benefit_checks"
    ],
    model: {
      provider: provider || "local",
      model: model || "server-portfolio-linked",
      usedSearch: Boolean(usedSearch),
      currentSourceNote: currentSourceNote || ""
    },
    riskProfile: {
      status: riskProfile?.completed ? "completed" : "missing_or_incomplete",
      preferredStyle: riskProfile?.preferredStyle || ""
    },
    agent: agentSummary ? {
      version: agentSummary.agentVersion,
      status: agentSummary.status,
      nextBestAction: agentSummary.nextBestAction
    } : null
  };
}

export function getComplianceStatus(userId) {
  const riskProfile = readRiskProfile(userId);
  const auditLog = readAuditLog(userId);
  const answerAudits = readAssistantAnswerAudits(userId);
  const complianceCases = readComplianceCases(userId);
  const emailJsConfigured = Boolean(process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && process.env.EMAILJS_PUBLIC_KEY);
  const emailProvider =
    process.env.RESEND_API_KEY ? "resend" :
    process.env.SENDGRID_API_KEY ? "sendgrid" :
    process.env.POSTMARK_SERVER_TOKEN ? "postmark" :
    (process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ? "aws_ses" :
    emailJsConfigured ? "emailjs" :
    process.env.EMAIL_WEBHOOK_URL ? "webhook" :
    "dry_run";
  return {
    generatedAt: new Date().toISOString(),
    status: "backend_controls_enabled",
    dataPaths: dataPathsForUser(userId),
    controls: {
      backendVerifiedPortfolioOnly: true,
      promptFilesBlockedFromPublicStaticServing: true,
      assistantReadOnly: true,
      productionAuthSwitchAvailable: true,
      sessionExpiryEnabled: true,
      twoFactorAuthAvailable: true,
      auditLogEnabled: true,
      riskProfileGateEnabled: true,
      allocationReviewRangeGuardEnabled: true,
      legalCurrentSourceGuardEnabled: true,
      documentConfirmationWorkflowEnabled: true,
      assistantAnswerAuditEnabled: true,
      complianceCaseWorkflowEnabled: true,
      emailProviderDeliverySupported: emailProvider !== "dry_run",
      scheduledAgentRunsEnabled: String(process.env.AGENT_SCHEDULER_ENABLED || "true").toLowerCase() !== "false",
      providerKeyTestingSupported: false,
      soleAnswerModel: "Qwen3-8B",
      groundingValidatorEnabled: true,
      privateRetrievalCacheIsolationEnabled: true
    },
    productionReadiness: {
      authRequired: String(process.env.REQUIRE_AUTH || "").toLowerCase() === "true",
      twoFactorRequired: String(process.env.REQUIRE_2FA || "true").toLowerCase() !== "false",
      hostedDatabaseConfigured: Boolean(process.env.DATABASE_URL || process.env.PENSIONS_DB_PATH),
      storageMode: storageStatus().mode,
      emailProvider,
      externalCronRecommended: true
    },
    productionControlsStillNeeded: [
      "database_encryption_or_managed_encryption",
      "provider_consent_management",
      "push_notification_provider"
    ],
    riskProfileStatus: riskProfile.completed ? "completed" : riskProfile.status,
    auditEvents: auditLog.length,
    assistantAnswerAudits: answerAudits.length,
    openComplianceCases: complianceCases.filter((item) => item.status === "open").length,
    latestAuditEvents: auditLog.slice(0, 10),
    latestAnswerAudits: answerAudits.slice(0, 5),
    latestComplianceCases: complianceCases.slice(0, 5)
  };
}

export function recordAssistantAnswerAudit(userId, {
  question = "",
  answer = "",
  provider = "",
  model = "",
  usedSearch = false,
  currentSourceNote = "",
  compliance = {},
  dashboard = {},
  dataUsed = [],
  dependencyWarning = ""
} = {}) {
  const audits = readAssistantAnswerAudits(userId);
  const legalQuestion = /\b(legal|law|employer|scheme|transfer|tax|rights|trustee|guarantee|protected pension age|ombudsman|regulator|hmrc|fca|tpr)\b/i.test(question);
  const audit = {
    id: newId("answer_audit"),
    generatedAt: isoNow(),
    promptVersion: ASSISTANT_PROMPT_VERSION,
    provider,
    model,
    usedSearch: Boolean(usedSearch),
    legalQuestion,
    adviceBoundary: compliance.adviceBoundary || "planning_support_not_regulated_financial_advice",
    currentSourceNote,
    warningShown: String(dependencyWarning || "").trim(),
    dashboardHash: hashJson({
      pensionPotValue: dashboard.pensionPotValue,
      monthlyTarget: dashboard.monthlyTarget,
      projectedMonthlyIncome: dashboard.projectedMonthlyIncome,
      monthlyGap: dashboard.monthlyGap,
      investmentProfile: dashboard.investmentProfile,
      dataQuality: dashboard.dataQuality,
      accounts: dashboard.pensionAccounts,
      documents: dashboard.documents
    }),
    dashboardDataUsed: Array.isArray(dataUsed) ? dataUsed.slice(0, 30) : [],
    question: String(question || "").slice(0, 2_000),
    answerPreview: String(answer || "").slice(0, 6_000)
  };
  audits.unshift(audit);
  writeAssistantAnswerAudits(userId, audits.slice(0, 300));
  appendAuditEvent(userId, {
    type: "assistant_answer_audited",
    answerAuditId: audit.id,
    provider,
    model,
    usedSearch: audit.usedSearch,
    legalQuestion
  });
  return audit;
}

export function listAssistantAnswerAudits(userId, { limit = 50 } = {}) {
  return readAssistantAnswerAudits(userId).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function createComplianceCaseIfNeeded(userId, {
  question = "",
  provider = "",
  model = "",
  usedSearch = false,
  currentSourceNote = "",
  answerAuditId = ""
} = {}) {
  if (!highRiskPensionQuestion(question)) return null;
  const cases = readComplianceCases(userId);
  const questionKey = hashJson(String(question || "").toLowerCase().replace(/\s+/g, " ").trim());
  const existing = cases.find((item) => item.questionKey === questionKey && item.status !== "closed");
  if (existing) return existing;
  const complianceCase = {
    id: newId("case"),
    userId,
    type: "pension_transfer_or_legal_boundary_review",
    status: "open",
    priority: "high",
    questionKey,
    questionPreview: String(question || "").slice(0, 240),
    reason: "Question may involve transfer, consolidation, guarantees, defined benefit, protected pension age, exit charges, employer scheme powers or legal/tax boundary issues.",
    provider,
    model,
    usedSearch: Boolean(usedSearch),
    currentSourceNote,
    answerAuditId,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    reviewedAt: null,
    reviewedBy: null,
    adminNote: ""
  };
  cases.unshift(complianceCase);
  writeComplianceCases(userId, cases.slice(0, 300));
  appendAuditEvent(userId, { type: "compliance_case_created", caseId: complianceCase.id, caseType: complianceCase.type });
  return complianceCase;
}

export function listComplianceCases({ status = "all" } = {}) {
  const cases = [];
  for (const userId of listKnownUsers()) {
    for (const item of readComplianceCases(userId)) cases.push({ ...item, userId });
  }
  const filtered = status === "all" ? cases : cases.filter((item) => item.status === status);
  return filtered.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export function updateComplianceCase(caseId, { status = "", adminNote = "", reviewedBy = "admin" } = {}) {
  const allowed = new Set(["open", "reviewing", "resolved", "closed"]);
  const nextStatus = String(status || "").trim();
  if (!allowed.has(nextStatus)) throw new Error("Unsupported compliance case status");
  for (const userId of listKnownUsers()) {
    const cases = readComplianceCases(userId);
    const item = cases.find((entry) => entry.id === caseId);
    if (!item) continue;
    item.status = nextStatus;
    item.adminNote = String(adminNote || item.adminNote || "").trim();
    item.reviewedBy = reviewedBy;
    item.reviewedAt = isoNow();
    item.updatedAt = isoNow();
    writeComplianceCases(userId, cases);
    appendAuditEvent(userId, { type: "compliance_case_updated", caseId, status: nextStatus, reviewedBy });
    return item;
  }
  const error = new Error("Compliance case not found");
  error.status = 404;
  throw error;
}
