import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function freePort() {
  const socket = createServer();
  await new Promise((resolveListen, reject) => socket.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test server exited early with ${child.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for test server.");
}

test("production auth entry routes remain public while protected data requires a session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pensions-auth-routes-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd:ROOT,
    stdio:["ignore", "pipe", "pipe"],
    env:{
      ...process.env,
      PORT:String(port),
      NODE_ENV:"production",
      PENSIONS_STORAGE:"sqlite",
      PENSIONS_DB_PATH:join(directory, "auth.sqlite"),
      REQUIRE_AUTH:"true",
      REQUIRE_2FA:"false",
      AGENT_SCHEDULER_ENABLED:"false",
      REDIS_URL:"redis://127.0.0.1:1",
      LOCAL_LLM_BASE_URL:"http://127.0.0.1:1",
      EMBEDDING_SERVICE_URL:"http://127.0.0.1:1",
      RERANK_SERVICE_URL:"http://127.0.0.1:1",
      OBJECT_STORAGE_MODE:"local",
      REQUIRE_MALWARE_SCAN:"false",
      APPROVED_CORPUS_BOOTSTRAP_ON_START:"false",
      APPROVED_CORPUS_MANIFEST_PATH:"disabled",
      APPROVED_CORPUS_MANIFEST_SHA256:"disabled"
    }
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolveExit) => child.exitCode === null ? child.once("exit", resolveExit) : resolveExit());
    await rm(directory, { recursive:true,force:true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child);
    const anonymousSession = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(anonymousSession.status, 200);
    assert.equal((await anonymousSession.json()).authenticated, false);

    const blockedPortfolio = await fetch(`${baseUrl}/api/portfolio`);
    assert.equal(blockedPortfolio.status, 401);

    const email = `release-${Date.now()}@example.com`;
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ email,password:"Strongpass123",displayName:"Release Test",require2fa:false,userId:"alex-morgan" })
    });
    assert.equal(registration.status, 201);
    const auth = await registration.json();
    assert.notEqual(auth.userId, "alex-morgan");
    assert.ok(auth.sessionToken);

    const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ email,password:"Anotherpass123",require2fa:false })
    });
    assert.equal(duplicate.status, 409);

    const authenticatedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers:{ Authorization:`Bearer ${auth.sessionToken}` }
    });
    assert.equal(authenticatedSession.status, 200);
    assert.equal((await authenticatedSession.json()).authenticated, true);

    const allowedPortfolio = await fetch(`${baseUrl}/api/portfolio`, {
      headers:{ Authorization:`Bearer ${auth.sessionToken}` }
    });
    assert.equal(allowedPortfolio.status, 200);

    const unauthenticatedMfa = await fetch(`${baseUrl}/api/auth/2fa/start`, {
      method:"POST",headers:{ "Content-Type":"application/json" },body:"{}"
    });
    assert.equal(unauthenticatedMfa.status, 401);

    const readiness = await fetch(`${baseUrl}/api/ready`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).ready, false);
  } catch (error) {
    error.message += `\nServer diagnostics:\n${diagnostics}`;
    throw error;
  }
});

test("local demo mode still accepts its explicit demo user without a session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pensions-demo-routes-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd:ROOT,
    stdio:["ignore", "pipe", "pipe"],
    env:{
      ...process.env,
      PORT:String(port),
      NODE_ENV:"development",
      PENSIONS_STORAGE:"sqlite",
      PENSIONS_DB_PATH:join(directory, "demo.sqlite"),
      REQUIRE_AUTH:"false",
      REQUIRE_2FA:"true",
      AGENT_SCHEDULER_ENABLED:"false",
      REDIS_URL:"redis://127.0.0.1:1",
      APPROVED_CORPUS_BOOTSTRAP_ON_START:"false"
    }
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolveExit) => child.exitCode === null ? child.once("exit", resolveExit) : resolveExit());
    await rm(directory, { recursive:true,force:true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child);
    const response = await fetch(`${baseUrl}/api/portfolio`, { headers:{ "X-Demo-User-Id":"local-release-demo" } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.agent);
  } catch (error) {
    error.message += `\nServer diagnostics:\n${diagnostics}`;
    throw error;
  }
});
