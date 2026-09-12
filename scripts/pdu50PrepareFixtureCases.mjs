// Evaluator-role preparation only. Never constructs or sends a model request.
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadPdu50EvaluatorRole} from './lib/pdu50Pack.mjs';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [rootArg,profileArg]=process.argv.slice(2);if(!rootArg||!profileArg)throw Error('Fresh output root and existing protected-read sandbox required');
const root=resolve(rootArg),profile=resolve(profileArg);
if(existsSync(root))throw Error('Fresh preparation root required');
const cases=loadPdu50EvaluatorRole().cases.filter(row=>row.label_status==='DRAFT_FIXTURE_BINDING_AND_REVIEW_REQUIRED');
if(cases.length!==12)throw Error('Unexpected fixture-only case inventory');
mkdirSync(root,{mode:0o700});const records=[];
for(const item of cases){
  const output=resolve(root,item.case_id);
  const result=spawnSync('/usr/bin/sandbox-exec',['-f',profile,process.execPath,resolve('scripts/pdu50PrepareCase.mjs'),'--case',item.case_id,'--output',output],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  if(result.status!==0)throw Error(item.case_id+' preparation failed: '+result.stderr);
  const path=resolve(output,'preparation-receipt.json');const receipt=JSON.parse(readFileSync(path));
  if(receipt.evaluator_material_loaded!==false||receipt.model_generation!=='NOT_RUN')throw Error('Preparation role violation');
  records.push({case_id:item.case_id,receipt:path,receipt_sha256:hash(path),database:receipt.database,database_sha256:hash(receipt.database),
    status:'SEEDED_PENDING_INDEPENDENT_FIXTURE_BINDING_REVIEW'});
}
const receipt={scope:'PDU50_FIXTURE_CASE_PREPARATION_NOT_ACCEPTANCE',cases:records,
  prepared_cases:records.length,label_review:'NOT_RUN',browser:'NOT_RUN',model:'NOT_RUN',formal_credit:false,sealed_unseen_accessed:false};
writeFileSync(resolve(root,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,prepared_cases:records.length,case_status:'CASE_NOT_READY_PENDING_BINDING_REVIEW',model_started:false}));
