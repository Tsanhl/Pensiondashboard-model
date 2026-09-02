import {
  isPostgresStorage,
  postgresQuery,
  readPublicFacts,
  writePublicFacts
} from "../store/userDataStore.js";

function normalizeFact(collection,fact) {
  return {
    ...fact,collectionId:collection.collection_id,jurisdiction:collection.jurisdiction,
    validFrom:collection.valid_from,validTo:collection.valid_to,lastVerifiedAt:collection.last_verified_at,
    reviewCycleDays:Number(collection.review_cycle_days || 7),fineTuningEligible:false,status:"active"
  };
}

export async function upsertPublicFactCollection(collection) {
  const facts = (collection.facts || []).map((fact) => normalizeFact(collection,fact));
  if (isPostgresStorage()) {
    await postgresQuery("BEGIN");
    try {
      await postgresQuery("UPDATE public_facts SET status='replaced',updated_at=now() WHERE collection_id=$1",[collection.collection_id]);
      for (const fact of facts) {
        await postgresQuery(
          `INSERT INTO public_facts
           (id,collection_id,topic,label,value_json,unit,operator,condition_text,jurisdiction,valid_from,valid_to,source_url,source_section,last_verified_at,review_cycle_days,status,metadata,updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16::jsonb,now())
           ON CONFLICT (id) DO UPDATE SET collection_id=EXCLUDED.collection_id,topic=EXCLUDED.topic,label=EXCLUDED.label,
             value_json=EXCLUDED.value_json,unit=EXCLUDED.unit,operator=EXCLUDED.operator,condition_text=EXCLUDED.condition_text,
             jurisdiction=EXCLUDED.jurisdiction,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,
             source_url=EXCLUDED.source_url,source_section=EXCLUDED.source_section,last_verified_at=EXCLUDED.last_verified_at,
             review_cycle_days=EXCLUDED.review_cycle_days,status='active',metadata=EXCLUDED.metadata,updated_at=now()`,
          [fact.id,fact.collectionId,fact.topic,fact.label,JSON.stringify(fact.value),fact.unit || null,fact.operator || null,
            fact.condition || null,fact.jurisdiction,fact.validFrom,fact.validTo,fact.source_url,fact.source_section || null,
            fact.lastVerifiedAt,fact.reviewCycleDays,JSON.stringify({ taxYear:collection.tax_year,fineTuningEligible:false })]
        );
      }
      await postgresQuery("COMMIT");
    } catch (error) {
      await postgresQuery("ROLLBACK");
      throw error;
    }
    return facts;
  }
  const retained = readPublicFacts().filter((fact) => fact.collectionId !== collection.collection_id);
  writePublicFacts([...facts,...retained]);
  return facts;
}

function queryTerms(query) {
  const ignored = new Set(["what","when","where","which","that","this","with","from","does","have","into","your","about","pension","pensions","current","much","for","the","and","are","how","year","tax","income","united","kingdom"]);
  return new Set((String(query).toLowerCase().match(/[a-z0-9]+/g) || []).filter((term) => term.length > 2 && !/^\d+$/.test(term) && !ignored.has(term)));
}

function relevance(fact,terms) {
  const haystack = `${fact.id || ""} ${fact.topic} ${fact.label} ${fact.source_section || fact.sourceSection || ""}`.toLowerCase();
  const words = new Set(haystack.match(/[a-z0-9]+/g) || []);
  return [...terms].filter((term) => words.has(term)).length;
}

export async function findPublicFacts(query,{ at = new Date().toISOString().slice(0,10),limit = 8 } = {}) {
  const terms = queryTerms(query);
  if (!terms.size) return [];
  let facts;
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `SELECT id,collection_id AS "collectionId",topic,label,value_json AS value,unit,operator,
              condition_text AS condition,jurisdiction,valid_from AS "validFrom",valid_to AS "validTo",
              source_url,source_section,last_verified_at AS "lastVerifiedAt",review_cycle_days AS "reviewCycleDays",status,metadata
       FROM public_facts WHERE status='active' AND valid_from <= $1::date AND valid_to >= $1::date`,[at]
    );
    facts = result.rows;
  } else {
    facts = readPublicFacts().filter((fact) => fact.status === "active" && fact.validFrom <= at && fact.validTo >= at);
  }
  const ranked = facts.map((fact) => ({ ...fact,relevance:relevance(fact,terms) }))
    .filter((fact) => fact.relevance > 0).sort((a,b) => b.relevance - a.relevance);
  const best = ranked[0]?.relevance || 0;
  const scottishSpecific = terms.has("scottish") && ranked.some((fact) => /scottish/i.test(`${fact.topic} ${fact.label}`));
  if (best < 2 && !scottishSpecific) return [];
  return ranked.filter((fact) => fact.relevance === best).slice(0,limit);
}
