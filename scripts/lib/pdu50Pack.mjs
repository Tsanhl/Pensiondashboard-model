import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const readJson=(relative)=>JSON.parse(readFileSync(resolve(ROOT,relative),'utf8'));
const readJsonl=(relative)=>readFileSync(resolve(ROOT,relative),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

function exactCaseIds(rows,label){
  const expected=Array.from({length:50},(_,index)=>`PDU50-${String(index+1).padStart(3,'0')}`);
  if(JSON.stringify(rows.map((row)=>row.case_id))!==JSON.stringify(expected))throw new Error(`${label} does not contain the exact ordered PDU50 case set`);
}

// These loaders deliberately expose separate trust roles. Callers constructing
// model requests may use only the product role plus evidence returned by the
// normal authenticated repositories; they must never import evaluator material.
export function loadPdu50ProductRole(){
  const suite=readJson('evaluation/pdu50/suite_manifest.json');
  const messages=readJsonl('evaluation/pdu50/product_messages.jsonl');
  exactCaseIds(messages,'product_messages');
  if(messages.some((row)=>Object.keys(row).some((key)=>!['case_id','user_turns'].includes(key))))throw new Error('Product role contains a non-product field');
  return {role:'MODEL_VISIBLE_PRODUCT_MESSAGES',suite:{suite_id:suite.suite_id,role:suite.role},messages};
}

export function loadPdu50HarnessRole(){
  const setup=readJsonl('evaluation/pdu50/harness_setup.jsonl');
  exactCaseIds(setup,'harness_setup');
  return {role:'HARNESS_ONLY_SETUP',setup,fixturePack:readJson('fixtures/synthetic_portfolios.json')};
}

export function loadPdu50EvaluatorRole(){
  const cases=readJsonl('evaluation/pdu50/evaluator_manifest.jsonl');
  exactCaseIds(cases,'evaluator_manifest');
  return {role:'EVALUATOR_ONLY_NOT_MODEL_INPUT',cases,numericReference:readJson('evaluation/pdu50/numeric_reference.json'),sourceCatalog:readJson('evaluation/pdu50/official_source_catalog.json')};
}

export function reconcilePdu50SourceCatalog(){
  const catalog=loadPdu50EvaluatorRole().sourceCatalog;
  const manifest=readJson('approved-materials/approved-corpus-manifest-20260908-repair-v1.json');
  const normalize=(url)=>String(url || '').trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?/,'').replace(/\/$/,'');
  const records=catalog.sources.map((lead)=>{
    const exactLocalDocuments=manifest.documents.filter((document)=>normalize(document.canonical_location)===normalize(lead.url));
    return {source_id:lead.source_id,pack_corpus_admitted:lead.corpus_admitted,exact_local_document_ids:exactLocalDocuments.map((document)=>document.id),exact_local_match_count:exactLocalDocuments.length,admission_effect:'NONE_REQUIRES_EXPLICIT_SOURCE_AND_LABEL_REVIEW'};
  });
  return {role:'EVALUATOR_READINESS_ONLY_NOT_MODEL_INPUT',catalog_as_of:catalog.as_of,local_manifest_id:manifest.corpus_id,local_manifest_approval_status:manifest.approval_status,source_leads:records.length,exact_canonical_matches:records.filter((record)=>record.exact_local_match_count>0).length,not_exactly_matched:records.filter((record)=>record.exact_local_match_count===0).length,automatically_admitted_for_pdu50:0,records};
}
