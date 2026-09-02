import { assertModelIdentity, configuredModelIdentity } from "./modelIdentityService.js";
import { expandCitationAliases } from "./modelContextService.js";

const MODEL = process.env.LOCAL_LLM_MODEL || "qwen3-8b-pension";
const BASE_URL = String(process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const TRANSPORT = String(process.env.LOCAL_LLM_TRANSPORT || "openai").toLowerCase();

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(Number(process.env.LOCAL_LLM_TIMEOUT_MS || 120_000));
  return signal ? AbortSignal.any([timeout,signal]) : timeout;
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
  const temperature = Number.isFinite(Number(generationConfig.temperature)) ? Number(generationConfig.temperature) : 0.1;
  const topP = Number.isFinite(Number(generationConfig.topP)) ? Number(generationConfig.topP) : 1;
  const maxTokens = Number.isFinite(Number(generationConfig.maxTokens)) ? Number(generationConfig.maxTokens) : Number(process.env.LOCAL_LLM_MAX_TOKENS || 320);
  const seed = Number.isFinite(Number(generationConfig.seed)) ? Number(generationConfig.seed) : null;
  let response;
  if (TRANSPORT === "ollama") {
    response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream: false, think: false, messages: [{ role: "system", content: system }, ...messages], options: { temperature,top_p:topP,num_ctx:8192,num_predict:maxTokens,...(seed == null ? {} : { seed }) } }),
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

export async function localModelStatus() {
  try {
    const target = TRANSPORT === "ollama" ? `${BASE_URL}/api/tags` : `${BASE_URL}/v1/models`;
    const response = await fetch(target, { signal: AbortSignal.timeout(1200), headers: process.env.LOCAL_LLM_API_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_API_KEY}` } : {} });
    if (Object.values(configuredModelIdentity()).some(Boolean)) {
      const payload = await response.json();
      assertModelIdentity(payload.data?.find((item) => item.id === MODEL), configuredModelIdentity());
    }
    return { provider: "local", model: MODEL, transport: TRANSPORT, endpoint: BASE_URL, available: response.ok, soleAnswerModel: true };
  } catch {
    return { provider: "local", model: MODEL, transport: TRANSPORT, endpoint: BASE_URL, available: false, soleAnswerModel: true };
  }
}
