import { isoNow } from "../utils/values.js";
import {
  isPostgresStorage,
  newId,
  postgresQuery,
  readConversationRecords,
  writeConversationRecords
} from "../store/userDataStore.js";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../services/cacheService.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function clone(value) {
  return structuredClone(value);
}

export async function createConversation(userId) {
  const now = isoNow();
  const conversation = {
    id: newId("chat"), userId, summary: "", resolvedEntities: {}, state: {}, messages: [],
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + RETENTION_MS).toISOString()
  };
  if (isPostgresStorage()) {
    await postgresQuery(
      `INSERT INTO chat_sessions (id,user_id,summary,resolved_entities,state,expires_at,created_at,updated_at)
       VALUES ($1,$2,'','{}'::jsonb,'{}'::jsonb,$3,$4,$4)`,
      [conversation.id, userId, conversation.expiresAt, now]
    );
  } else {
    const records = readConversationRecords(userId).filter((item) => Date.parse(item.expiresAt) > Date.now());
    records.unshift(conversation);
    writeConversationRecords(userId, records);
  }
  await cacheSet(`conversation:${userId}:${conversation.id}`, conversation, 1800);
  return clone(conversation);
}

export async function getConversation(userId, sessionId) {
  if (!sessionId) return null;
  const cacheKey = `conversation:${userId}:${sessionId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;
  if (isPostgresStorage()) {
    const session = await postgresQuery(
      `SELECT id,user_id AS "userId",summary,resolved_entities AS "resolvedEntities",state,
              created_at AS "createdAt",updated_at AS "updatedAt",expires_at AS "expiresAt"
       FROM chat_sessions WHERE id=$1 AND user_id=$2 AND expires_at > now()`, [sessionId, userId]
    );
    if (!session.rows[0]) return null;
    const messages = await postgresQuery(
      `SELECT id,role,content,client_request_id AS "clientRequestId",sources,metadata,created_at AS "createdAt"
       FROM chat_messages WHERE session_id=$1 AND user_id=$2 ORDER BY created_at ASC`, [sessionId, userId]
    );
    const conversation = { ...session.rows[0], messages: messages.rows };
    await cacheSet(cacheKey, conversation, 1800);
    return conversation;
  }
  const conversation = clone(readConversationRecords(userId).find((item) => item.id === sessionId && Date.parse(item.expiresAt) > Date.now()) || null);
  if (conversation) await cacheSet(cacheKey, conversation, 1800);
  return conversation;
}

export async function listConversations(userId, limit = 20) {
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `SELECT s.id,s.summary,s.resolved_entities AS "resolvedEntities",s.state,s.created_at AS "createdAt",
              s.updated_at AS "updatedAt",s.expires_at AS "expiresAt",
              (SELECT content FROM chat_messages m WHERE m.session_id=s.id ORDER BY m.created_at ASC LIMIT 1) AS title
       FROM chat_sessions s WHERE s.user_id=$1 AND s.expires_at > now() ORDER BY s.updated_at DESC LIMIT $2`,
      [userId, Math.min(100, Math.max(1, limit))]
    );
    return result.rows;
  }
  return readConversationRecords(userId).filter((item) => Date.parse(item.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit)
    .map(({ messages, ...item }) => ({ ...item, title: messages?.[0]?.content || "New conversation" }));
}

export async function appendConversationMessage(userId, sessionId, message) {
  const entry = { id: message.id || newId("msg"), createdAt: isoNow(), sources: [], metadata: {}, ...message };
  if (isPostgresStorage()) {
    await postgresQuery(
      `INSERT INTO chat_messages (id,session_id,user_id,role,content,client_request_id,sources,metadata,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
       ON CONFLICT (user_id,client_request_id) DO NOTHING`,
      [entry.id, sessionId, userId, entry.role, entry.content, entry.clientRequestId || null, JSON.stringify(entry.sources || []), JSON.stringify(entry.metadata || {}), entry.createdAt]
    );
    await postgresQuery("UPDATE chat_sessions SET updated_at=$1,expires_at=$2 WHERE id=$3 AND user_id=$4", [entry.createdAt, new Date(Date.now() + RETENTION_MS).toISOString(), sessionId, userId]);
  } else {
    const records = readConversationRecords(userId);
    const conversation = records.find((item) => item.id === sessionId);
    if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    if (entry.clientRequestId && conversation.messages.some((item) => item.clientRequestId === entry.clientRequestId)) {
      return clone(conversation.messages.find((item) => item.clientRequestId === entry.clientRequestId));
    }
    conversation.messages.push(entry);
    conversation.updatedAt = entry.createdAt;
    conversation.expiresAt = new Date(Date.now() + RETENTION_MS).toISOString();
    writeConversationRecords(userId, records);
  }
  await cacheDeletePrefix(`conversation:${userId}:${sessionId}`);
  return clone(entry);
}

export async function updateConversation(userId, sessionId, patch = {}) {
  const updatedAt = isoNow();
  if (isPostgresStorage()) {
    await postgresQuery(
      `UPDATE chat_sessions SET summary=$1,resolved_entities=$2::jsonb,state=$3::jsonb,updated_at=$4
       WHERE id=$5 AND user_id=$6`,
      [patch.summary || "", JSON.stringify(patch.resolvedEntities || {}), JSON.stringify(patch.state || {}), updatedAt, sessionId, userId]
    );
    await cacheDeletePrefix(`conversation:${userId}:${sessionId}`);
    return getConversation(userId, sessionId);
  }
  const records = readConversationRecords(userId);
  const conversation = records.find((item) => item.id === sessionId);
  if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  Object.assign(conversation, patch, { updatedAt });
  writeConversationRecords(userId, records);
  await cacheSet(`conversation:${userId}:${sessionId}`, conversation, 1800);
  return clone(conversation);
}

export async function findMessageByRequest(userId, clientRequestId) {
  if (!clientRequestId) return null;
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `SELECT id,session_id AS "sessionId",role,content,client_request_id AS "clientRequestId",sources,metadata,created_at AS "createdAt"
       FROM chat_messages WHERE user_id=$1 AND client_request_id=$2 LIMIT 1`, [userId, clientRequestId]
    );
    return result.rows[0] || null;
  }
  for (const conversation of readConversationRecords(userId)) {
    const message = conversation.messages?.find((item) => item.clientRequestId === clientRequestId);
    if (message) return { ...clone(message), sessionId: conversation.id };
  }
  return null;
}

export async function deleteConversation(userId, sessionId) {
  if (isPostgresStorage()) {
    const result = await postgresQuery("DELETE FROM chat_sessions WHERE id=$1 AND user_id=$2", [sessionId, userId]);
    await cacheDeletePrefix(`conversation:${userId}:${sessionId}`);
    return result.rowCount > 0;
  }
  const records = readConversationRecords(userId);
  const next = records.filter((item) => item.id !== sessionId);
  writeConversationRecords(userId, next);
  await cacheDeletePrefix(`conversation:${userId}:${sessionId}`);
  return next.length !== records.length;
}

export async function removeSourceCitations(userId, sourceIds = []) {
  const ids = [...new Set(sourceIds.map(String))];
  if (!ids.length) return 0;
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `UPDATE chat_messages SET sources=COALESCE((
         SELECT jsonb_agg(source) FROM jsonb_array_elements(sources) source
         WHERE NOT ((source->>'source_id') = ANY($2::text[]))
       ), '[]'::jsonb)
       WHERE user_id=$1 AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(sources) source WHERE (source->>'source_id') = ANY($2::text[])
       )`, [userId, ids]
    );
    await cacheDeletePrefix(`conversation:${userId}:`);
    return result.rowCount;
  }
  const records = readConversationRecords(userId);
  let changed = 0;
  for (const conversation of records) {
    for (const message of conversation.messages || []) {
      const before = message.sources?.length || 0;
      message.sources = (message.sources || []).filter((source) => !ids.includes(String(source.source_id)));
      if (message.sources.length !== before) changed += 1;
    }
  }
  if (changed) writeConversationRecords(userId, records);
  await cacheDeletePrefix(`conversation:${userId}:`);
  return changed;
}
