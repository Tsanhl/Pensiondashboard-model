import { renderCitationMarkers } from './citationRendererService.js';
import { completePresentLegalFacts, stripUnsupportedLegalCycles, validateGroundedAnswer } from './groundingService.js';

// One production post-generation path, also callable by isolated development
// diagnostics. No source override is exposed through HTTP or WebSocket.
export function evaluateGeneratedAnswer({question,query,generated,modelSources,modelContext}) {
  const completed=completePresentLegalFacts(question,generated.answer,modelSources);
  const evidence=modelSources.map(source=>`${source.title || ''}\n${source.oscolaCitation || ''}\n${source.snippet || ''}`).join('\n');
  const rendered=renderCitationMarkers({answer:stripUnsupportedLegalCycles(completed.answer,evidence),citationIds:[...new Set([...(generated.citationIds || []),...completed.addedCitationIds])],sources:modelSources});
  const validation=rendered.valid
    ? validateGroundedAnswer({answer:rendered.answer,citationIds:rendered.citationIds,sources:modelContext.evidenceSources,intent:query.intent,legalEvidenceRequired:query.legal_evidence_required,userSuppliedText:query.self_contained_query,claimLevel:Boolean(query.personal_dashboard_primary),claimCitations:rendered.claimCitations,clarificationContext:query.missing_facts ? {missingFacts:query.missing_facts,schemeDocumentsPresent:modelContext.evidenceSources.some(s=>s.scope === "USER_DOCUMENTS" && /scheme rules|trust deed|contractual terms/i.test(`${s.title} ${s.section} ${s.snippet}`))} : null})
    : {valid:false,reason:rendered.inventedCitationIds.length?'invented_citation':'citation_render_failure',inventedCitationIds:rendered.inventedCitationIds,hiddenCitationIds:rendered.hiddenCitationIds,missingCitationMetadataIds:rendered.missingCitationMetadataIds};
  return {rendered,validation};
}
