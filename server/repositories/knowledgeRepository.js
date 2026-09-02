import { isoNow } from "../utils/values.js";
import {
  isPostgresStorage,
  postgresQuery,
  readKnowledgeChunks,
  readKnowledgeDocuments,
  writeKnowledgeChunks,
  writeKnowledgeDocuments
} from "../store/userDataStore.js";
import { cosineSimilarity } from "../services/embeddingService.js";
import { removeSourceCitations } from "./conversationRepository.js";

const PUBLIC_USER = "__public__";

function vectorLiteral(vector) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

export async function activateKnowledgeDocument(userId, document, chunks) {
  if (isPostgresStorage()) {
    await postgresQuery("BEGIN");
    try {
      await postgresQuery(
        `INSERT INTO knowledge_documents
         (id,user_id,version,title,authority,jurisdiction,canonical_location,published_at,effective_at,expires_at,checksum,licence,mime_type,object_key,normalized_text_key,scope,status,metadata,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'processing',$17::jsonb,$18,$18)
         ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version,title=EXCLUDED.title,checksum=EXCLUDED.checksum,
           object_key=EXCLUDED.object_key,normalized_text_key=EXCLUDED.normalized_text_key,status='processing',metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at`,
        [document.id,userId,document.version,document.title,document.authority || null,document.jurisdiction || null,
          document.canonicalLocation || null,document.publishedAt || null,document.effectiveDate || null,document.expiryDate || null,
          document.checksum,document.licence || null,document.mimeType || null,document.objectKey || null,
          document.normalizedTextKey || null,document.scope,JSON.stringify(document.metadata || {}),document.updatedAt || isoNow()]
      );
      await postgresQuery("DELETE FROM knowledge_chunks WHERE document_id=$1 AND user_id=$2", [document.id, userId]);
      for (const chunk of chunks) {
        await postgresQuery(
          `INSERT INTO knowledge_chunks (id,document_id,user_id,section_path,ordinal,content,token_count,embedding,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,$9::jsonb)`,
          [chunk.id,document.id,userId,chunk.sectionPath,chunk.ordinal,chunk.content,chunk.tokenCount,vectorLiteral(chunk.embedding),JSON.stringify(chunk.metadata || {})]
        );
      }
      await postgresQuery("UPDATE knowledge_documents SET status='active',updated_at=$1 WHERE id=$2 AND user_id=$3", [isoNow(), document.id, userId]);
      await postgresQuery("COMMIT");
    } catch (error) {
      await postgresQuery("ROLLBACK");
      throw error;
    }
    return { ...document, status: "active" };
  }
  const documents = readKnowledgeDocuments(userId);
  const previousIndex = documents.findIndex((item) => item.id === document.id);
  const active = { ...document, status: "active", updatedAt: isoNow() };
  if (previousIndex >= 0) documents[previousIndex] = active;
  else documents.unshift(active);
  const retained = readKnowledgeChunks(userId).filter((item) => item.documentId !== document.id);
  writeKnowledgeChunks(userId, [...chunks, ...retained]);
  writeKnowledgeDocuments(userId, documents);
  return active;
}

export async function listKnowledgeDocuments(userId, { includeChunkCounts = true } = {}) {
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `SELECT id,user_id AS "userId",version,title,authority,jurisdiction,canonical_location AS "canonicalLocation",
              published_at AS "publishedAt",effective_at AS "effectiveDate",expires_at AS "expiryDate",checksum,licence,
              mime_type AS "mimeType",object_key AS "objectKey",normalized_text_key AS "normalizedTextKey",scope,status,metadata,
              created_at AS "createdAt",updated_at AS "updatedAt",
              ${includeChunkCounts ? '(SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id=knowledge_documents.id)' : 'NULL::int'} AS "chunkCount"
       FROM knowledge_documents WHERE user_id IN ($1,$2) ORDER BY updated_at DESC`, [userId, PUBLIC_USER]
    );
    return result.rows;
  }
  return [userId, ...(userId === PUBLIC_USER ? [] : [PUBLIC_USER])].flatMap((owner) => {
    // Corpus-version checks need only document metadata. In SQLite/JSON mode,
    // counting chunks otherwise decodes the entire embedding store needlessly.
    if (!includeChunkCounts) return readKnowledgeDocuments(owner);
    const counts = readKnowledgeChunks(owner).reduce((map, chunk) => map.set(chunk.documentId, (map.get(chunk.documentId) || 0) + 1), new Map());
    return readKnowledgeDocuments(owner).map((item) => ({ ...item,chunkCount:counts.get(item.id) || 0 }));
  });
}

function legalReferencePhrases(value) {
  return [...String(value || "").matchAll(/\b(?:section|regulation|article|rule|schedule|paragraph)\s+\d+[a-z]?(?:\([0-9a-z]+\))*/gi)]
    .map((match) => match[0].toLowerCase());
}

function phraseCoverage(phrases, value) {
  if (!phrases.length) return 0;
  const normalized = String(value || "").toLowerCase();
  return phrases.filter((phrase) => normalized.includes(phrase)).length / phrases.length;
}

function lexicalScore(query, content, { title = "",section = "" } = {}) {
  const terms = new Set(String(query).toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!terms.size) return 0;
  const evidenceText = `${title} ${section} ${content}`.toLowerCase();
  const words = new Set(evidenceText.match(/[a-z0-9]+/g) || []);
  const coverage = [...terms].filter((term) => words.has(term)).length / terms.size;
  return coverage;
}

export async function searchKnowledge(userId, embedding, limit = 8, query = "") {
  if (isPostgresStorage()) {
    const legalReferences = legalReferencePhrases(query);
    const result = await postgresQuery(
      `SELECT c.id AS source_id,d.title,c.section_path,c.content,d.effective_at,d.updated_at,d.scope,d.jurisdiction,
              LEAST(1.0, 0.65 * (1 - (c.embedding <=> $3::vector))
                + 0.20 * ts_rank_cd(to_tsvector('english', concat_ws(' ', d.title, c.section_path, c.content)), plainto_tsquery('english', $5))
                + CASE WHEN cardinality($6::text[]) > 0 AND EXISTS (
                    SELECT 1 FROM unnest($6::text[]) AS legal_ref
                    WHERE lower(concat_ws(' ', d.title, c.section_path, c.content)) LIKE '%' || legal_ref || '%'
                  ) THEN 0.05 ELSE 0 END
                + CASE WHEN cardinality($6::text[]) > 0 AND EXISTS (
                    SELECT 1 FROM unnest($6::text[]) AS legal_ref
                    WHERE lower(c.section_path) LIKE '%' || legal_ref || '%'
                  ) THEN 0.15 ELSE 0 END
                + CASE WHEN position(lower(d.title) in lower($5)) > 0 THEN 0.10 ELSE 0 END) AS score,
              d.authority,d.canonical_location,d.id AS document_id,d.version,d.expires_at,d.metadata AS document_metadata
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
       WHERE c.user_id IN ($1,$2) AND d.status='active' AND (d.expires_at IS NULL OR d.expires_at > now())
         AND COALESCE(c.metadata->>'quarantined','false') <> 'true'
       ORDER BY score DESC LIMIT $4`, [userId, PUBLIC_USER, vectorLiteral(embedding), Math.min(300, limit), query, legalReferences]
    );
    return result.rows.map((row) => ({
      sourceId: row.source_id, title: row.title, section: row.section_path, snippet: row.content,
      effectiveDate: row.effective_at, updatedAt: row.updated_at, scope: row.scope, authority: row.authority,
      jurisdiction: row.jurisdiction,
      canonicalLocation: row.canonical_location, documentId:row.document_id,version:row.version,expiresAt:row.expires_at,
      sourceType:row.document_metadata?.sourceType || null,sourceRole:row.document_metadata?.sourceRole || null,authorityRank:Number(row.document_metadata?.authorityRank || 0.5),oscolaCitation:row.document_metadata?.oscolaCitation || row.title,sourceMetadata:row.document_metadata || {},score: Number(row.score)
    }));
  }
  const owners = [userId, ...(userId === PUBLIC_USER ? [] : [PUBLIC_USER])];
  const legalReferences = legalReferencePhrases(query);
  const documents = new Map(owners.flatMap((owner) => readKnowledgeDocuments(owner)).filter((item) => item.status === "active" && (!item.expiryDate || Date.parse(item.expiryDate) > Date.now())).map((item) => [item.id, item]));
  return owners.flatMap((owner) => readKnowledgeChunks(owner)).filter((chunk) => documents.has(chunk.documentId) && !chunk.metadata?.quarantined).map((chunk) => {
    const document = documents.get(chunk.documentId);
    return {
      sourceId: chunk.id, title: document.title, section: chunk.sectionPath, snippet: chunk.content,
      effectiveDate: document.effectiveDate || null, updatedAt: document.updatedAt, scope: document.scope,
      authority: document.authority || null, jurisdiction: document.jurisdiction || null, canonicalLocation: document.canonicalLocation || null,
      documentId:document.id,version:document.version,expiresAt:document.expiryDate || null,
      sourceType:document.metadata?.sourceType || null,sourceRole:document.metadata?.sourceRole || null,authorityRank:Number(document.metadata?.authorityRank || 0.5),oscolaCitation:document.metadata?.oscolaCitation || document.title,sourceMetadata:document.metadata || {},
      score: Math.min(1,
        0.65 * cosineSimilarity(embedding, chunk.embedding)
        + 0.20 * lexicalScore(query, chunk.content, { title:document.title,section:chunk.sectionPath })
        + 0.05 * phraseCoverage(legalReferences, `${document.title} ${chunk.sectionPath} ${chunk.content}`)
        + 0.15 * phraseCoverage(legalReferences, chunk.sectionPath)
        + 0.10 * (document.title && String(query).toLowerCase().includes(String(document.title).toLowerCase()) ? 1 : 0)
      )
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function deleteKnowledgeDocument(userId, documentId) {
  if (isPostgresStorage()) {
    const documentRows = await postgresQuery("SELECT id,object_key AS \"objectKey\",normalized_text_key AS \"normalizedTextKey\" FROM knowledge_documents WHERE id=$1 AND user_id=$2", [documentId,userId]);
    const chunkRows = await postgresQuery("SELECT id FROM knowledge_chunks WHERE document_id=$1 AND user_id=$2", [documentId,userId]);
    const result = await postgresQuery("DELETE FROM knowledge_documents WHERE id=$1 AND user_id=$2", [documentId, userId]);
    if (result.rowCount) await removeSourceCitations(userId, chunkRows.rows.map((row) => row.id));
    return result.rowCount ? documentRows.rows[0] : null;
  }
  const documents = readKnowledgeDocuments(userId);
  const document = documents.find((item) => item.id === documentId);
  const sourceIds = readKnowledgeChunks(userId).filter((item) => item.documentId === documentId).map((item) => item.id);
  writeKnowledgeDocuments(userId, documents.filter((item) => item.id !== documentId));
  writeKnowledgeChunks(userId, readKnowledgeChunks(userId).filter((item) => item.documentId !== documentId));
  await removeSourceCitations(userId, sourceIds);
  return document || null;
}
