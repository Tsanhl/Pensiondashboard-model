const REQUIRED_QUALIFICATION_CHILD_ENV = Object.freeze([
  "QUALIFICATION_SOURCE_BINDINGS_SHA256",
  "QUALIFICATION_CANONICAL_USER_ID",
  "QUALIFICATION_ATTEMPT_TELEMETRY",
  "QUALIFICATION_RUN_ID",
  "QUALIFICATION_CONTEXT_HMAC_KEY",
  "QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM",
  "QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256",
  "LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY",
  "LOCAL_LLM_MAX_ATTEMPTS",
  "LOCAL_LLM_RETRY_READY_TIMEOUT_MS",
  "CYCLE_V2_RETRY_RUN_ERRORS",
]);

export function qualificationChildEnvironment(source,enabled) {
  if (!enabled) return {};
  const values = Object.fromEntries(REQUIRED_QUALIFICATION_CHILD_ENV.map((key) => [key,String(source?.[key] ?? "")]));
  const missing = REQUIRED_QUALIFICATION_CHILD_ENV.filter((key) => !values[key]);
  if (missing.length) throw new Error(`Qualification child environment is missing: ${missing.join(", ")}`);
  if (!/^[0-9a-f]{64}$/.test(values.QUALIFICATION_SOURCE_BINDINGS_SHA256)) throw new Error("Qualification source-binding digest is invalid.");
  if (!/^post-t4-\d{14}-[0-9a-f]{8}$/.test(values.QUALIFICATION_RUN_ID) || !/^[0-9a-f]{64}$/.test(values.QUALIFICATION_CONTEXT_HMAC_KEY)) throw new Error("Qualification run or context-capability identity is invalid.");
  if (!values.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM.includes("PUBLIC KEY") || !/^[0-9a-f]{64}$/.test(values.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256) ||
      createHash("sha256").update(values.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_PEM).digest("hex") !== values.QUALIFICATION_RESPONSE_SIGNING_PUBLIC_KEY_SHA256) throw new Error("Qualification response-signing public identity is invalid.");
  if (values.QUALIFICATION_CANONICAL_USER_ID !== "alex-morgan") throw new Error("Qualification canonical user is not pinned to alex-morgan.");
  if (values.QUALIFICATION_ATTEMPT_TELEMETRY !== "true" || values.LOCAL_LLM_ALLOW_TRUNCATION_RECOVERY !== "false" || values.CYCLE_V2_RETRY_RUN_ERRORS !== "false") {
    throw new Error("Qualification telemetry, truncation recovery, or retry policy is not fail-closed.");
  }
  if (values.LOCAL_LLM_MAX_ATTEMPTS !== "2" || !Number.isInteger(Number(values.LOCAL_LLM_RETRY_READY_TIMEOUT_MS)) || Number(values.LOCAL_LLM_RETRY_READY_TIMEOUT_MS) < 1) {
    throw new Error("Qualification model attempt count or retry-ready timeout is invalid.");
  }
  return values;
}

export { REQUIRED_QUALIFICATION_CHILD_ENV };
import { createHash } from "node:crypto";
