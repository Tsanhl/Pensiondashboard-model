import "./server/loadEnv.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { getPortfolioSeedForUser } from "./server/portfolioStore.js";
import { handleProductApiRoute } from "./server/routes/productApiRoutes.js";
import { handleChatRoute } from "./server/routes/chatRoutes.js";
import { handleDocumentMemoryRoute } from "./server/routes/documentMemoryRoutes.js";
import { handleMaterialRoute } from "./server/routes/materialRoutes.js";
import { runAgentForUser } from "./server/services/agentService.js";
import { findSessionByToken } from "./server/services/authService.js";
import { cacheStatus, initialiseCache } from "./server/services/cacheService.js";
import { bootstrapApprovedCorpus } from "./server/services/approvedCorpusService.js";
import { localModelStatus } from "./server/services/localModelService.js";
import { embeddingStatus } from "./server/services/embeddingService.js";
import { objectStorageStatus } from "./server/services/objectStorageService.js";
import { loggingStatus } from "./server/services/debugLoggingService.js";
import { startKnowledgeFreshnessServices } from "./server/services/materialFreshnessService.js";
import { startAgentScheduler } from "./server/services/schedulerService.js";
import { getReadiness } from "./server/services/readinessService.js";
import { appendSystemEvent, initialiseDataStore, storageStatus } from "./server/store/userDataStore.js";
import { attachChatWebSocket } from "./server/websocket/chatWebSocket.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_FILES = new Set(["/index.html", "/app.js", "/styles.css"]);
const MIME_TYPES = {
  ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml"
};

await initialiseDataStore();
await initialiseCache();
if (String(process.env.APPROVED_CORPUS_BOOTSTRAP_ON_START || "false").toLowerCase() === "true") {
  try {
    const result = await bootstrapApprovedCorpus();
    console.log(`Approved corpus bootstrap complete: ${result.indexed} indexed, ${result.skipped} unchanged.`);
  } catch (error) {
    console.error(`Approved corpus bootstrap failed (${error.code || "CORPUS_BOOTSTRAP_FAILED"}).`);
  }
}

function json(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  if (status === 204) { res.writeHead(204); return res.end(); }
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" });
  res.end(JSON.stringify(payload));
}

function readRequest(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Request too large"), { status:413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req) {
  return (await readRequest(req, 128_000)).toString("utf8");
}

async function readBuffer(req) {
  return readRequest(req, Number(process.env.DOCUMENT_MAX_BYTES || 20 * 1024 * 1024));
}

function bearerToken(req) {
  const auth = String(req?.headers?.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const headerToken = String(req?.headers?.["x-session-token"] || "").trim();
  if (headerToken) return headerToken;
  const cookie = String(req?.headers?.cookie || "");
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("pension_session="));
  return match ? decodeURIComponent(match.slice("pension_session=".length)) : "";
}

function productionAuthRequired() {
  return String(process.env.REQUIRE_AUTH || "").toLowerCase() === "true";
}

function mfaRequired() {
  return String(process.env.REQUIRE_2FA || "true").toLowerCase() !== "false";
}

function sessionForRequest(req) {
  return bearerToken(req) ? findSessionByToken(bearerToken(req)) : null;
}

function authenticatedUserId(req) {
  const sessionUser = sessionForRequest(req)?.userId;
  if (sessionUser) return sessionUser;
  if (productionAuthRequired()) throw Object.assign(new Error("Sign in is required."), { status:401 });
  const headerUser = req?.headers?.["x-demo-user-id"];
  return String((Array.isArray(headerUser) ? headerUser[0] : headerUser) || process.env.AUTHENTICATED_USER_ID || "alex-morgan").trim();
}

function publicPath(pathname) {
  return pathname === "/api/status" || pathname === "/api/ready" || pathname.startsWith("/api/auth/") || pathname.startsWith("/api/materials/") || (!pathname.startsWith("/api/") && pathname !== "/chat");
}

function requireSession(req, pathname) {
  if (!productionAuthRequired() || publicPath(pathname)) return null;
  const found = sessionForRequest(req);
  if (!found?.session) throw Object.assign(new Error("Sign in is required for this API."), { status:401 });
  if (mfaRequired() && !found.session.mfaVerified) throw Object.assign(new Error("Two-factor verification is required for this API."), { status:403 });
  return found;
}

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (pathname === "/") pathname = "/index.html";
  const cleanPath = normalize(pathname).replace(/^\.\.(\/|\\|$)/, "");
  const extension = extname(cleanPath).toLowerCase();
  if (cleanPath.includes("..") || !PUBLIC_FILES.has(cleanPath)) {
    res.writeHead(404, { "Content-Type":"text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  try {
    const file = await readFile(join(ROOT, cleanPath));
    res.writeHead(200, { "Content-Type":MIME_TYPES[extension] || "application/octet-stream", "Cache-Control":"no-cache" });
    return res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type":"text/plain; charset=utf-8" });
    return res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const requestId = String(req.headers["x-request-id"] || randomUUID()).slice(0, 160);
  res.setHeader("X-Request-Id", requestId);
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requireSession(req, url.pathname);
    if (url.pathname === "/api/status") {
      return json(res, 200, {
        service:"pension-assistant",status:"ok",readOnly:true,
        model:await localModelStatus(),embeddings:embeddingStatus(),storage:storageStatus(),cache:cacheStatus(),objectStorage:objectStorageStatus(),logging:loggingStatus(),
        pipeline:["chat_service","conversation_store","query_processor","retrieval_service","local_model_gateway","grounding_validator"]
      });
    }
    if (url.pathname === "/api/ready") {
      if (req.method !== "GET") return json(res, 405, { error:"Method not allowed" });
      const readiness = await getReadiness();
      return json(res, readiness.ready ? 200 : 503, readiness);
    }
    const materials = await handleMaterialRoute({ req,res,url,json,readBody });
    if (materials !== false) return materials;
    if (url.pathname.startsWith("/api/auth/")) {
      const authUserId = sessionForRequest(req)?.userId || (productionAuthRequired() ? null : authenticatedUserId(req));
      const authRoute = await handleProductApiRoute({ req,res,url,json,readBody,userId:authUserId,seedPortfolio:authUserId ? getPortfolioSeedForUser(authUserId) : {} });
      if (authRoute !== false) return authRoute;
      return json(res, 404, { error:"Not found" });
    }
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/chat") return serveStatic(req, res);
    const userId = authenticatedUserId(req);
    if (url.pathname === "/api/portfolio") {
      const agent = runAgentForUser({ userId,persist:true,reason:"portfolio_load" });
      return json(res, 200, { ...agent.dashboard,agent:{ status:agent.status,nextBestAction:agent.nextBestAction,assistantContext:agent.assistantContext,checks:agent.dashboardChecks },actions:agent.actions.slice(0,6),notifications:agent.notifications.slice(0,6) });
    }
    const chat = await handleChatRoute({ req,res,url,json,readBody,userId });
    if (chat !== false) return chat;
    const documents = await handleDocumentMemoryRoute({ req,res,url,json,readBody,readBuffer,userId });
    if (documents !== false) return documents;
    const product = await handleProductApiRoute({ req,res,url,json,readBody,userId,seedPortfolio:getPortfolioSeedForUser(userId) });
    if (product !== false) return product;
    return serveStatic(req, res);
  } catch (error) {
    if ((error.status || 500) >= 500) {
      try { appendSystemEvent({ type:"server_error",path:new URL(req.url, `http://${req.headers.host}`).pathname,method:req.method,message:error.message || "Server error" }); } catch {}
    }
    return json(res, error.status || 500, { error:error.message || "Server error",request_id:requestId });
  }
});

attachChatWebSocket(server, {
  authenticateUpgrade(req) {
    const found = requireSession(req, "/chat");
    if (found?.userId) return found.userId;
    return authenticatedUserId(req);
  }
});

server.listen(PORT, () => {
  startAgentScheduler();
  startKnowledgeFreshnessServices();
  console.log(`Pensions dashboard running on http://localhost:${PORT}`);
});
