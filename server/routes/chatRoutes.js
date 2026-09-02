import { deleteConversation, getConversation, listConversations } from "../repositories/conversationRepository.js";
import { runChat } from "../services/chatService.js";
import { checkRateLimitAsync } from "../services/rateLimitService.js";

function match(pathname, expression) {
  const result = pathname.match(expression);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

export async function handleChatRoute({ req, res, url, json, readBody, userId }) {
  const chatPath = url.pathname === "/chat" || url.pathname === "/api/assistant";
  if (chatPath) {
    if (req.method !== "POST") return json(res, 405, { error:"Method not allowed" });
    await checkRateLimitAsync({ key:`chat:${userId}`,limit:Number(process.env.CHAT_RATE_LIMIT || 30),windowMs:60_000 });
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const result = await runChat({
        userId,
        sessionId:body.session_id,
        clientRequestId:body.client_request_id || body.clientRequestId,
        message:body.message || body.question,
        abortSignal:controller.signal,
      });
      return json(res, 200, { ...result, answer:result.response });
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  }
  if (url.pathname === "/api/conversations") {
    if (req.method !== "GET") return json(res, 405, { error:"Method not allowed" });
    return json(res, 200, { conversations:await listConversations(userId, Number(url.searchParams.get("limit") || 20)) });
  }
  const conversationMatch = match(url.pathname, /^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    if (req.method === "GET") {
      const conversation = await getConversation(userId, conversationMatch[0]);
      return conversation ? json(res, 200, { conversation }) : json(res, 404, { error:"Conversation not found" });
    }
    if (req.method === "DELETE") {
      const deleted = await deleteConversation(userId, conversationMatch[0]);
      return json(res, deleted ? 204 : 404, deleted ? {} : { error:"Conversation not found" });
    }
    return json(res, 405, { error:"Method not allowed" });
  }
  return false;
}
