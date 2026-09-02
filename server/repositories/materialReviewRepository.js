import { isPostgresStorage,newId,postgresQuery,readMaterialReviewItems,writeMaterialReviewItems } from "../store/userDataStore.js";

export async function stageMaterialReviewItem(input = {}) {
  const now = new Date().toISOString();
  const allowedStatuses = new Set(["pending_legal_review","approved","rejected"]);
  const status = allowedStatuses.has(input.status) ? input.status : "pending_legal_review";
  const item = { id:input.id || newId("review"),sourceDocumentId:input.sourceDocumentId,sourceChecksum:input.sourceChecksum,sourceType:input.sourceType,title:input.title,content:input.content,citations:input.citations || [],metadata:input.metadata || {},status,createdAt:now,updatedAt:now };
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `INSERT INTO material_review_items (id,source_document_id,source_checksum,source_type,title,content,citations,metadata,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$10)
       ON CONFLICT (id) DO UPDATE SET source_checksum=EXCLUDED.source_checksum,source_type=EXCLUDED.source_type,title=EXCLUDED.title,content=EXCLUDED.content,citations=EXCLUDED.citations,metadata=EXCLUDED.metadata,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at
       RETURNING id,source_document_id AS "sourceDocumentId",source_checksum AS "sourceChecksum",source_type AS "sourceType",title,content,citations,metadata,status,created_at AS "createdAt",updated_at AS "updatedAt"`,
      [item.id,item.sourceDocumentId,item.sourceChecksum,item.sourceType,item.title,item.content,JSON.stringify(item.citations),JSON.stringify(item.metadata),item.status,now]
    );
    return result.rows[0];
  }
  const items = readMaterialReviewItems();
  const index = items.findIndex((row) => row.id === item.id);
  if (index >= 0) items[index] = { ...items[index],...item,createdAt:items[index].createdAt };
  else items.unshift(item);
  writeMaterialReviewItems(items);
  return item;
}

export async function listMaterialReviewItems(status = "all") {
  if (isPostgresStorage()) {
    const values = [];
    const where = status === "all" ? "" : " WHERE status=$1";
    if (status !== "all") values.push(status);
    const result = await postgresQuery(`SELECT id,source_document_id AS "sourceDocumentId",source_checksum AS "sourceChecksum",source_type AS "sourceType",title,content,citations,metadata,status,created_at AS "createdAt",updated_at AS "updatedAt" FROM material_review_items${where} ORDER BY updated_at DESC`, values);
    return result.rows;
  }
  const items = readMaterialReviewItems();
  return status === "all" ? items : items.filter((item) => item.status === status);
}
