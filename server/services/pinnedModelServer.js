import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

// Local development/evaluation only. No unbounded queue or automatic retry of
// a failed inference: callers must record the failure before attempting another.
export function createPinnedModelServer({ command, args, deadlineMs = 115_000, startupMs = 120_000, workerKillGraceMs = 1_000, workerRestartLimit = 3, requestBodyLimitBytes = 100_000, headersTimeoutMs = 10_000, runtimeBindings = {}, generationPolicy = null }) {
  for (const [name,value] of Object.entries({ deadlineMs,startupMs,workerKillGraceMs,workerRestartLimit,requestBodyLimitBytes,headersTimeoutMs })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  let worker = null, ready = false, identity = null, active = null, stopping = false, restarts = 0;
  let startupTimer, killTimer;
  const runtimeHash = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
  const json = (response, status, value) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  function settle(status, value) {
    if (!active) return;
    const current = active;
    active = null;
    clearTimeout(current.timer);
    current.response.off("close", current.disconnect);
    json(current.response, status, value);
  }
  function recycle() {
    ready = false;
    if (!worker) return;
    const old = worker;
    old.kill("SIGTERM");
    killTimer = setTimeout(() => { if (worker === old) old.kill("SIGKILL"); }, workerKillGraceMs);
    killTimer.unref();
  }
  function startWorker() {
    if (stopping) return;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    worker = child;
    child.stdin.on("error", () => {});
    startupTimer = setTimeout(() => { settle(503, { error: "Model startup timed out" }); recycle(); }, startupMs);
    startupTimer.unref();
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (worker !== child) return;
      let event;
      try { event = JSON.parse(line); } catch { settle(502, { error: "Invalid worker protocol" }); recycle(); return; }
      if (event.type === "ready") {
        clearTimeout(startupTimer);
        identity = { ...event.identity,supervisor_sha256:runtimeHash,request_deadline_ms:deadlineMs,worker_startup_ms:startupMs,
          worker_kill_grace_ms:workerKillGraceMs,worker_restart_limit:workerRestartLimit,
          request_body_limit_bytes:requestBodyLimitBytes,headers_timeout_ms:Math.min(deadlineMs,headersTimeoutMs),...runtimeBindings };
        ready = true;
        console.log(`Pinned model ready: ${identity.id}; adapter ${identity.adapter_sha256}`);
      } else if (active && event.id === active.id) {
        if (event.type === "result") {
          settle(200, { id: event.id, object: "chat.completion", model: identity.id, runtime_identity: identity,
            choices: [{ index: 0, message: { role: "assistant", content: event.content }, finish_reason: event.finish_reason }],
            usage: event.usage, runtime_metrics: event.metrics });
        } else { settle(502, { error: event.message || "Worker generation failed" }); recycle(); }
      }
    });
    child.on("error", () => { ready = false; settle(503, { error: "Model worker could not start" }); });
    child.on("close", () => {
      if (worker !== child) return;
      clearTimeout(startupTimer); clearTimeout(killTimer);
      worker = null; ready = false;
      settle(503, { error: "Model worker exited" });
      // Avoid an infinite restart storm on bad artifacts or missing dependencies.
      if (!stopping && restarts++ < workerRestartLimit) startWorker();
    });
  }
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && ["/health", "/v1/models"].includes(request.url)) {
      json(response, ready ? 200 : 503, request.url === "/v1/models"
        ? { object: "list", data: identity ? [{ object: "model", ...identity }] : [], ready, busy: Boolean(active) }
        : { ready, busy: Boolean(active), worker_pid: worker?.pid, restarts, identity });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { json(response, 404, { error: "Not found" }); return; }
    if (!ready || active) { json(response, 503, { error: active ? "Model busy; no queue" : "Model not ready" }); return; }
    // Reserve before reading a potentially slow body, not just before inference.
    const id = randomUUID();
    const disconnect = () => { if (active?.id === id) { settle(499, { error: "Client disconnected" }); recycle(); } };
    active = { id, response, disconnect, timer: setTimeout(() => {
      if (active?.id === id) { settle(504, { error: "Model deadline exceeded; worker cancelled" }); recycle(); }
    }, deadlineMs) };
    response.on("close", disconnect);
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > requestBodyLimitBytes) throw new Error("Request body too large");
      }
      if (active?.id !== id) return;
      const input = JSON.parse(body);
      if (input.model !== identity.id || input.adapters != null || input.adapter_path != null || input.stream === true) throw new Error("Pinned model required; overrides and streaming unsupported");
      if (!Array.isArray(input.messages) || !input.messages.length || input.messages.some((m) => !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string")) throw new Error("Invalid messages");
      const maxTokens = input.max_tokens ?? 320, temperature = input.temperature ?? 0, topP = input.top_p ?? 1, seed = input.seed ?? 42;
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 512 || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isFinite(topP) || topP <= 0 || topP > 1 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid generation parameters");
      if (generationPolicy?.enforce_exact === true &&
          (maxTokens !== generationPolicy.max_tokens || temperature !== generationPolicy.temperature || topP !== generationPolicy.top_p || seed !== generationPolicy.seed)) {
        throw new Error("Generation parameters do not match the pinned qualification policy");
      }
      worker.stdin.write(`${JSON.stringify({ id, messages: input.messages, max_tokens: maxTokens, temperature, top_p: topP, seed })}\n`);
    } catch (error) { if (active?.id === id) settle(400, { error: error.message }); }
  });
  server.requestTimeout = deadlineMs;
  server.headersTimeout = Math.min(deadlineMs, headersTimeoutMs);
  startWorker();
  return { server, async stop() {
    stopping = true;
    settle(503, { error: "Model service stopping" });
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    const child = worker;
    const exited = child ? new Promise((resolve) => child.once("close", resolve)) : Promise.resolve();
    recycle();
    await Promise.all([closed, exited]);
  } };
}
