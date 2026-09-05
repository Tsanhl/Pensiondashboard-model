// A configured adapter must never be inferred merely from a friendly model name.
export function assertModelIdentity(identity, expected = {}) {
  for (const [key, value] of Object.entries(expected)) {
    if (value && identity?.[key] !== value) throw Object.assign(new Error(`Local model identity mismatch: ${key}`), { code: "MODEL_IDENTITY_MISMATCH" });
  }
  return identity;
}

export function configuredModelIdentity() {
  if (!process.env.LOCAL_LLM_EXPECTED_ADAPTER_SHA256 && !process.env.LOCAL_LLM_EXPECTED_BASE_SHA256) return {};
  return {
    id: process.env.LOCAL_LLM_MODEL,
    adapter_sha256: process.env.LOCAL_LLM_EXPECTED_ADAPTER_SHA256,
    base_sha256: process.env.LOCAL_LLM_EXPECTED_BASE_SHA256,
    adapter_config_sha256: process.env.LOCAL_LLM_EXPECTED_ADAPTER_CONFIG_SHA256,
    checkpoint_sha256: process.env.LOCAL_LLM_EXPECTED_CHECKPOINT_SHA256,
    ...(process.env.LOCAL_LLM_EXPECTED_RUNTIME_CONFIGURATION_SHA256 ? { runtime_configuration_sha256:process.env.LOCAL_LLM_EXPECTED_RUNTIME_CONFIGURATION_SHA256 } : {}),
    ...(process.env.LOCAL_LLM_EXPECTED_PYTHON_ENVIRONMENT_SHA256 ? { python_environment_sha256:process.env.LOCAL_LLM_EXPECTED_PYTHON_ENVIRONMENT_SHA256 } : {}),
  };
}
