// Existing isolated answer reviewers; only explicit private development traces.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {runDevelopmentAnswerReview} from './lib/qualification-worker/aiReview.mjs';
const [manifestPath,outputPath]=process.argv.slice(2);
if(!manifestPath||!outputPath||existsSync(outputPath))throw Error('Explicit manifest and fresh private review directory required');
const manifest=JSON.parse(readFileSync(manifestPath));
if(manifest.scope!=='DEVELOPMENT_ONLY')throw Error('Development manifest required');
const cases=manifest.cases.map(c=>{
 const bytes=readFileSync(c.trace),t=JSON.parse(bytes);
 if(t.classification!=='DEVELOPMENT_ONLY')throw Error('Not a development trace');
 let complete=false;try{const payload=JSON.parse(t.generated.rawContent);complete=typeof payload.answer === "string" && Array.isArray(payload.citation_ids);}catch{}
 return {case_id:c.id,question:t.query.self_contained_query,history:t.modelContext.messages.slice(0,-1),generated_answer:t.generated.answer,
  displayed_answer:t.validation.valid?t.rendered.answer:'Answer withheld after validation; no completed legal answer displayed.',
  validator:t.validation,raw_json_complete:complete,evidence:t.modelContext.evidenceSources.map(s=>({...s,evidence_id:s.sourceId})),
  citation_aliases:t.modelContext.citationAliases,raw_receipt_sha256:createHash('sha256').update(bytes).digest('hex'),
  limitations:['Assess raw defects separately from displayed failure. Identify supported, contradicted, unsupported and legitimately unresolved claims in rationale. No expected answer supplied.']};
});
const packet={scope:'DEVELOPMENT_GENERATION_REVIEW_ONLY',candidate_sha256:manifest.adapter_sha256,cases};
mkdirSync(outputPath,{recursive:true,mode:0o700});writeFileSync(resolve(outputPath,'packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
const config=JSON.parse(readFileSync('config/qualification-worker.json'));config.__project_root=resolve('.');
const result=await runDevelopmentAnswerReview({packet,config,outputDir:resolve(outputPath)});
console.log(JSON.stringify({passed:result.passed,results:result.results}));process.exitCode=result.passed?0:1;
