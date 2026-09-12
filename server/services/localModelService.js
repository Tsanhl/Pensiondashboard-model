import { assertModelIdentity, configuredModelIdentity } from "./modelIdentityService.js";
import { expandCitationAliases } from "./modelContextService.js";

const MODEL = process.env.LOCAL_LLM_MODEL || "qwen3-8b-pension";
const BASE_URL = String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const TRANSPORT = String(process.env.LOCAL_LLM_TRANSPORT || "openai").toLowerCase();
const QUALIFICATION_MODE = process.env.QUALIFICATION_RUNTIME_MODE === "true";

function pinnedPositiveInteger(name, fallback) {
  if (QUALIFICATION_MODE && !process.env[name]) throw Object.assign(new Error(`${name} must be pinned in qualification mode.`), { code:"MODEL_CONFIG_ERROR" });
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error(`${name} must be a positive integer.`), { code:"MODEL_CONFIG_ERROR" });
  return value;
}

const RETRY_HEALTH_PROBE_TIMEOUT_MS = pinnedPositiveInteger("LOCAL_LLM_RETRY_HEALTH_PROBE_TIMEOUT_MS",2_000);
const RETRY_POLL_MS = pinnedPositiveInteger("LOCAL_LLM_RETRY_POLL_MS",1_000);
const MODEL_STATUS_TIMEOUT_MS = pinnedPositiveInteger("LOCAL_LLM_STATUS_TIMEOUT_MS",1_200);

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(Number(process.env.LOCAL_LLM_TIMEOUT_MS || 120_000));
  return signal ? AbortSignal.any([timeout,signal]) : timeout;
}

export function collapseRepeatedCiteTokens(text) {
  return String(text || "").replace(/((?:\{\{cite:[^}]+\}\}\s*){4,})/g, (block) => {
    const ids = [...block.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]);
    return `${[...new Set(ids)].map((id) => `{{cite:${id}}}`).join(" ")} `;
  });
}

export function recoverTruncatedJsonAnswer(content = "") {
  const collapsed = collapseRepeatedCiteTokens(String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
  const candidate = collapsed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || collapsed.match(/\{[\s\S]*\}/)?.[0] || collapsed;
  try {
    const payload = JSON.parse(candidate);
    if (typeof payload.answer === "string" && payload.answer.trim()) {
      const citationIds = Array.isArray(payload.citation_ids) ? payload.citation_ids.map(String) : [];
      return { answer: payload.answer.trim(), citationIds };
    }
  } catch {
    // Truncated JSON is recovered only when a complete sentence exists.
  }
  const rawField = collapsed.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!rawField) return null;
  let answer = rawField[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\")
    .replace(/\{\{cite:[^}]*$/, "")
    .trim();
  answer = collapseRepeatedCiteTokens(answer).trim();
  const lastStop = Math.max(answer.lastIndexOf("."), answer.lastIndexOf("!"), answer.lastIndexOf("?"));
  if (lastStop < 40) return null;
  // A citation follows the sentence terminator. Preserve only complete markers
  // already generated directly after that sentence, not an unfinished clause.
  const trailingCitations = answer.slice(lastStop + 1).match(/^(?:\s*\{\{cite:[^{}]+\}\})*/)?.[0] || "";
  answer = (answer.slice(0, lastStop + 1) + trailingCitations).trim();
  if (answer.length < 40) return null;
  const citationIds = [...new Set([...answer.matchAll(/\{\{cite:([^}]+)\}\}/g)].map((match) => match[1]))];
  return { answer, citationIds };
}

function parseModelOutput(content = "") {
  const clean = String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidate = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || clean.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const payload = JSON.parse(candidate);
      if (typeof payload.answer === "string") {
        const citationIds = Array.isArray(payload.citation_ids) ? payload.citation_ids.map(String) : [];
        let answer = payload.answer.trim();
        for (const id of citationIds) {
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          answer = answer.replace(new RegExp(`\\[\\s*source[_ ]?id\\s*:\\s*${escaped}\\s*\\]`, "gi"), `[${id}]`);
        }
        return { answer,citationIds };
      }
    } catch (error) {
      if (/^\s*\{/.test(clean)) throw Object.assign(new Error("Local Qwen service returned malformed JSON."), { code:"MODEL_INVALID_OUTPUT",cause:error });
    }
  }
  if (/^\s*\{/.test(clean)) throw Object.assign(new Error("Local Qwen service returned truncated JSON."), { code:"MODEL_INVALID_OUTPUT" });
  const citationIds = [...clean.matchAll(/\[([a-zA-Z0-9_-]+)\]/g)].map((match) => match[1]);
  return { answer: clean, citationIds: [...new Set(citationIds)] };
}

export async function generateLocalAnswer({ system, messages, signal, generationConfig = {}, citationAliases = {} }) {
  const temperature = Number.isFinite(Number(generationConfig.temperature)) ? Number(generationConfig.temperature) : Number(process.env.LOCAL_LLM_TEMPERATURE ?? 0.1);
  const topP = Number.isFinite(Number(generationConfig.topP)) ? Number(generationConfig.topP) : Number(process.env.LOCAL_LLM_TOP_P ?? 1);
  const maxTokens = Number.isFinite(Number(generationConfig.maxTokens)) ? Number(generationConfig.maxTokens) : Number(process.env.LOCAL_LLM_MAX_TOKENS || 320);
  const configuredSeed = process.env.LOCAL_LLM_SEED == null ? null : Number(process.env.LOCAL_LLM_SEED);
  const seed = Number.isFinite(Number(generationConfig.seed)) ? Number(generationConfig.seed) : (Number.isFinite(configuredSeed) ? configuredSeed : null);
  const contextTokens = Number(process.env.LOCAL_LLM_CONTEXT_TOKENS || 8192);
  let response;
  try {
    if (TRANSPORT === "ollama") {
      response = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: false, think: false, messages: [{ role: "system", content: system }, ...messages], options: { temperature,top_p:topP,num_ctx:contextTokens,num_predict:maxTokens,...(seed == null ? {} : { seed }) } }),
        signal: requestSignal(signal)
      });
    } else if (TRANSPORT === "openai") {
      response = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {}) },
        body: JSON.stringify({ model:MODEL,temperature,top_p:topP,max_tokens:maxTokens,...(seed == null ? {} : { seed }),messages:[{ role:"system",content:`/no_think\n${system}` },...messages],response_format:{ type:"json_object" },chat_template_kwargs:{ enable_thinking:false } }),
        signal: requestSignal(signal)
      });
    } else {
      throw Object.assign(new Error("LOCAL_LLM_TRANSPORT must be ollama or openai."), { code: "MODEL_CONFIG_ERROR" });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw Object.assign(new Error(`Local Qwen service fetch failed: ${error.message}`), { code: "MODEL_UNAVAILABLE", cause: error });
  }
  if (!response.ok) throw Object.assign(new Error(`Local Qwen service returned ${response.status}: ${(await response.text()).slice(0, 300)}`), { code: "MODEL_UNAVAILABLE" });
  const payload = await response.json();
  assertModelIdentity(payload.runtime_identity, configuredModelIdentity());
  const content = TRANSPORT === "ollama" ? payload.message?.content : payload.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error("Local Qwen service returned an empty answer."), { code: "MODEL_UNAVAILABLE" });
  let parsed;
  try { parsed = parseModelOutput(content); }
  catch (error) {
    // Retain invalid output for diagnostic audit, never as a user-visible answer.
    error.modelResponse = { rawContent: content, runtimeIdentity: payload.runtime_identity || null,
      runtimeMetrics: payload.runtime_metrics || null, usage: payload.usage || null,
      finishReason: payload.choices?.[0]?.finish_reason || payload.done_reason || null };
    throw error;
  }
  return {
    ...expandCitationAliases(parsed, citationAliases),
    model: MODEL,
    runtimeIdentity: payload.runtime_identity || null,
    runtimeMetrics: payload.runtime_metrics || null,
    transport: TRANSPORT,
    usage: TRANSPORT === "ollama"
      ? { prompt_tokens:payload.prompt_eval_count || null,completion_tokens:payload.eval_count || null,total_tokens:(payload.prompt_eval_count || 0) + (payload.eval_count || 0) || null }
      : payload.usage || null,
    finishReason: TRANSPORT === "ollama" ? payload.done_reason || null : payload.choices?.[0]?.finish_reason || null,
    rawContent:content,
    generationConfig:{ temperature,topP,maxTokens,seed }
  };
}

function recoveredAnswer(error, citationAliases = {}) {
  const recovered = recoverTruncatedJsonAnswer(error?.modelResponse?.rawContent || "");
  if (!recovered) return null;
  return {
    ...expandCitationAliases(recovered, citationAliases),
    model: MODEL,
    runtimeIdentity: error.modelResponse?.runtimeIdentity || null,
    runtimeMetrics: error.modelResponse?.runtimeMetrics || null,
    transport: TRANSPORT,
    usage: error.modelResponse?.usage || null,
    finishReason: error.modelResponse?.finishReason || "length",
    rawContent: error.modelResponse?.rawContent || "",
    recoveredFromTruncation: true,
    generationConfig: {}
  };
}

export async function generateLocalAnswerWithRetry(args) {
  const maxAttempts = Math.max(1, Math.min(2, Number(args?.maxAttempts ?? process.env.LOCAL_LLM_MAX_ATTEMPTS ?? 2)));
  const attemptLedger = [];
  const developmentAttemptOutputs = [];
  const capture = (attempt, result) => {
    if (process.env.PENSION_DEVELOPMENT_TRACE_ROOT && !QUALIFICATION_MODE && result?.rawContent != null) developmentAttemptOutputs.push({attempt,rawContent:String(result.rawContent).replace(/<think>[\s\S]*?<\/think>/gi,'[reasoning omitted]'),usage:result.usage,finishReason:result.finishReason});
  };
  const record = (event) => {
    const entry = { ...event,recorded_at:new Date().toISOString() };
    attemptLedger.push(entry);
    args?.onAttemptEvent?.(entry);
  };
  record({ event:"ATTEMPT_STARTED",attempt:1 });
  try {
    const first = await generateLocalAnswer(args);
    capture(1,first);
    record({ event:"ATTEMPT_SUCCEEDED",attempt:1,runtime_identity:first.runtimeIdentity || null });
    return { ...first, retry_used:false,retry_reason:null,generation_attempts:1,generation_attempt_ledger:attemptLedger,developmentAttemptOutputs };
  } catch (error) {
    capture(1,error.modelResponse);error.developmentAttemptOutputs=developmentAttemptOutputs;
    if (args?.signal?.aborted) throw error;
    const code = typeof error.code === "string" ? error.code : "";
    record({ event:"ATTEMPT_FAILED",attempt:1,reason:code || error.name || "MODEL_ERROR",runtime_identity:error.modelResponse?.runtimeIdentity || null });
    if (code !== "MODEL_INVALID_OUTPUT" && code !== "MODEL_UNAVAILABLE") throw error;
    if (maxAttempts < 2) {
      error.attempts = 1;
      error.retry_reason = null;
      error.generation_attempt_ledger = attemptLedger;
      throw error;
    }
    try {
      if (code === "MODEL_UNAVAILABLE") await waitForModelReady(args?.signal);
      record({ event:"ATTEMPT_STARTED",attempt:2,retry_reason:code });
      const second = await generateLocalAnswer(args);
      capture(2,second);
      record({ event:"ATTEMPT_SUCCEEDED",attempt:2,runtime_identity:second.runtimeIdentity || null });
      return { ...second,retry_used:true,retry_reason:code,generation_attempts:2,generation_attempt_ledger:attemptLedger,developmentAttemptOutputs };
    } catch (retryError) {
      capture(2,retryError.modelResponse);retryError.developmentAttemptOutputs=developmentAttemptOutputs;
      record({ event:"ATTEMPT_FAILED",attempt:2,reason:retryError?.code || retryError?.name || "MODEL_ERROR",runtime_identity:retryError?.modelResponse?.runtimeIdentity || null });
      if (retryError?.code === "MODEL_INVALID_OUTPUT" && String(process.env.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY || "true").toLowerCase() !== "false") {
        const recovered = recoveredAnswer(retryError, args?.citationAliases);
        if (recovered) return { ...recovered,retry_used:true,retry_reason:code,generation_attempts:2,generation_attempt_ledger:attemptLedger,developmentAttemptOutputs };
      }
      retryError.attempts = 2;
      retryError.retry_reason = code;
      retryError.generation_attempt_ledger = attemptLedger;
      throw retryError;
    }
  }
}

async function waitForModelReady(signal) {
  const deadline = Date.now() + pinnedPositiveInteger("LOCAL_LLM_RETRY_READY_TIMEOUT_MS",90_000);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error("Model retry cancelled.");
    try {
      const response = await fetch(`${BASE_URL}/v1/models`, {
        signal: signal ? AbortSignal.any([AbortSignal.timeout(RETRY_HEALTH_PROBE_TIMEOUT_MS), signal]) : AbortSignal.timeout(RETRY_HEALTH_PROBE_TIMEOUT_MS),
        headers: process.env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {},
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ready === true && payload?.data?.some((item) => item.id === MODEL)) return;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    await new Promise((accept) => setTimeout(accept, RETRY_POLL_MS));
  }
  throw Object.assign(new Error("Local model did not become ready for the single retry."), { code: "MODEL_UNAVAILABLE" });
}

export async function localModelStatus() {
  try {
    const target = TRANSPORT === "ollama" ? `${BASE_URL}/api/tags` : `${BASE_URL}/v1/models`;
    const response = await fetch(target, { signal: AbortSignal.timeout(MODEL_STATUS_TIMEOUT_MS), headers: process.env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {} });
    if (Object.values(configuredModelIdentity()).some(Boolean)) {
      const payload = await response.json();
      assertModelIdentity(payload.data?.find((item) => item.id === MODEL), configuredModelIdentity());
    }
    return { provider: "local", model: MODEL, transport: TRANSPORT, endpoint: BASE_URL, available: response.ok, soleAnswerModel: true };
  } catch {
    return { provider: "local", model: MODEL, transport: TRANSPORT, endpoint: BASE_URL, available: false, soleAnswerModel: true };
  }
}
