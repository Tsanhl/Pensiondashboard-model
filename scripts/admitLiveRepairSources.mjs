import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalHash} from './lib/qualification-worker/utils.mjs';
import {revalidateDevelopmentSourceReview} from './lib/qualification-worker/aiReview.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const root=resolve('approved-materials'), dir=join(root,'live-repair-20260908');
const packetPath=join(dir,'review-packet-v3.json'),packet=read(packetPath);
const config=read('config/qualification-worker.json');config.__project_root=process.cwd();
const reviewDir=join(dir,'review-v3');
revalidateDevelopmentSourceReview({packet,config,outputDir:reviewDir});
const proposal=read(join(dir,'source-proposal-v3.json'));
const reviewFiles=['source-admission-review.json',...['a','b'].flatMap(role=>['reviewer-receipt.json','execution.json','review-events.raw.jsonl','review-output.raw.json','review-output.json','review-schema.json'].map(name=>`reviewer-${role}/${name}`))];
const reviewBinding={scope:packet.scope,formal_credit:false,packet_path:'live-repair-20260908/review-packet-v3.json',packet_sha256:hash(packetPath),packet_canonical_sha256:canonicalHash(packet),
  files:reviewFiles.map(name=>({path:`live-repair-20260908/review-v3/${name}`,sha256:hash(join(reviewDir,name))}))};
const docs=proposal.documents.map(document=>{
 const ev=packet.evidence.find(x=>x.metadata?.id===document.id);
 if(!ev || canonicalHash(ev.metadata)!==canonicalHash(document) || hash(join(root,document.text_path))!==document.text_sha256)throw new Error('Source proposal or bytes differ from reviewed packet.');
 return {...document,approval_status:'approved',reviewer:'pensions-factual-review-a + pensions-evidence-review-b',source_review:reviewBinding};
});
const manifest=read(join(root,'approved-corpus-manifest.json'));
manifest.corpus_id='pensions-dashboard-runtime-corpus-2026-09-08-repair-v1';
manifest.parent_manifest_sha256=hash(join(root,'approved-corpus-manifest.json'));
manifest.approved_at=new Date().toISOString();manifest.approved_by='Owner-authorised development repair; existing source reviewers retained; additions independently reviewed by pinned A and B';
manifest.approval_scope='Operational corpus admission; original corpus preserved, four narrowly scoped sources added after two isolated reviews; no formal qualification credit or current-law guarantee.';
manifest.documents.push(...docs);
const destination=join(root,'approved-corpus-manifest-20260908-repair-v1.json');
if(existsSync(destination))throw new Error('Candidate manifest already exists; refusing overwrite.');
writeFileSync(destination,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
const safetyItem=packet.items.find(x=>x.item_id==='protective-notice-v2');
if(proposal.safety_notice!==safetyItem.proposed_text)throw new Error('Safety notice differs from reviewed text.');
const safety={version:'protective-notice-20260908-v2',scope:'GENERAL_SAFETY_NOTICE_ONLY',reviewed_at:'2026-09-08',review_after:'2026-10-08',text:safetyItem.proposed_text,review:reviewBinding,
 sources:packet.evidence.filter(x=>safetyItem.evidence_ids.includes(x.evidence_id)).map(x=>({source_id:x.evidence_id,title:x.metadata.title||'TPR pension scam guidance',canonical_url:x.metadata.final_url||x.metadata.url,
  retrieved_at:x.metadata.retrieved_at,effective_date:null,snippet:x.quote||x.content,source_hash:x.metadata.raw_sha256||x.metadata.sha256||x.metadata.retained_excerpt_sha256}))};
writeFileSync(join(dir,'protective-notice.json'),JSON.stringify(safety,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({manifest:destination,sha256:hash(destination),documents:manifest.documents.length,safety_sha256:hash(join(dir,'protective-notice.json')),formal_credit:false},null,2));
