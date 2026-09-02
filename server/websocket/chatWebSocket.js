import { WebSocketServer } from "ws";
import { runChat } from "../services/chatService.js";
import { checkRateLimitAsync } from "../services/rateLimitService.js";
import { findMessageByRequest, getConversation } from "../repositories/conversationRepository.js";

function send(socket, event, payload = {}, sequence = null) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ event, ...(sequence == null ? {} : { sequence }), ...payload }));
}

export function attachChatWebSocket(server, { authenticateUpgrade }) {
  const wss = new WebSocketServer({ noServer:true,clientTracking:true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/ws/chat") return socket.destroy();
    let userId;
    try { userId = authenticateUpgrade(req); } catch { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (webSocket) => wss.emit("connection", webSocket, req, userId));
  });
  wss.on("connection", (socket, _req, userId) => {
    socket.isAlive = true;
    const controllers = new Map();
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", async (raw) => {
      let input;
      try { input = JSON.parse(raw.toString()); } catch { return send(socket, "chat.error", { error:"Invalid JSON event." }); }
      if (input.event === "chat.cancel") {
        controllers.get(input.request_id)?.abort();
        controllers.delete(input.request_id);
        return send(socket, "chat.status", { request_id:input.request_id,status:"cancelled" });
      }
      if (!["chat.start", "chat.resume"].includes(input.event)) return send(socket, "chat.error", { error:"Unsupported chat event." });
      try {
        await checkRateLimitAsync({ key:`chat-ws:${userId}`,limit:Number(process.env.CHAT_RATE_LIMIT || 30),windowMs:60_000 });
        let sequence = Number(input.last_sequence || 0);
        if (input.event === "chat.resume") {
          const request = await findMessageByRequest(userId, input.request_id);
          const conversation = request ? await getConversation(userId, request.sessionId) : null;
          const answer = conversation?.messages?.find((item) => item.role === "assistant" && item.metadata?.requestId === input.request_id);
          if (!answer) return send(socket, "chat.error", { request_id:input.request_id,error:"No completed response is available to resume." }, ++sequence);
          send(socket, "chat.sources", { request_id:input.request_id,sources:answer.sources || [] }, ++sequence);
          return send(socket, "chat.completed", { session_id:request.sessionId,message_id:answer.id,response:answer.content,sources:answer.sources || [],confidence:answer.metadata?.confidence || "grounded",handoff:answer.metadata?.handoff || null,request_id:input.request_id,resumed:true }, ++sequence);
        }
        const requestId = input.client_request_id || input.request_id;
        const controller = new AbortController();
        controllers.set(requestId, controller);
        const result = await runChat({ userId,sessionId:input.session_id,clientRequestId:requestId,message:input.message,abortSignal:controller.signal,onEvent:(event,payload) => send(socket,event,payload,++sequence) });
        controllers.delete(requestId);
        const words = result.response.match(/\S+\s*/g) || [result.response];
        for (const delta of words) send(socket, "chat.delta", { request_id:input.client_request_id || input.request_id,delta }, ++sequence);
        send(socket, "chat.sources", { request_id:input.client_request_id || input.request_id,sources:result.sources }, ++sequence);
        send(socket, "chat.completed", { ...result,request_id:input.client_request_id || input.request_id }, ++sequence);
      } catch (error) {
        controllers.delete(input.client_request_id || input.request_id);
        send(socket, "chat.error", { request_id:input.client_request_id || input.request_id,error:error.message || "Chat failed",status:error.status || 500 });
      }
    });
    socket.on("close", () => { for (const controller of controllers.values()) controller.abort(); controllers.clear(); });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  return wss;
}
