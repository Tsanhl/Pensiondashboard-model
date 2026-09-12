// DEVELOPMENT_ONLY. Reads only owner-supplied development questions; never formal banks.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const output=process.argv[2];
if (!output || existsSync(resolve(output,'receipt.json'))) throw Error('Supply a fresh private output directory; existing receipts are immutable.');
mkdirSync(output,{recursive:true,mode:0o700});
const origin=process.env.LIVE_REPAIR_URL || 'http://127.0.0.1:3001';
if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname)) throw Error('Development probes must be loopback.');
const questions=JSON.parse(readFileSync(new URL('../test/fixtures/live-repair/owner-questions.json',import.meta.url))).questions;
const receipt={classification:'DEVELOPMENT_ONLY',started:new Date().toISOString(),origin,questions:[],identity:{},unseen_accessed:false};
const app=await fetch(origin+'/app.js');const bytes=Buffer.from(await app.arrayBuffer());receipt.identity.frontendServedSha256=createHash('sha256').update(bytes).digest('hex');receipt.identity.frontendLocalSha256=createHash('sha256').update(readFileSync(new URL('../app.js',import.meta.url))).digest('hex');
for(const endpoint of ['/api/status','/api/ready']){try{const r=await fetch(origin+endpoint,{signal:AbortSignal.timeout(30000)});const raw=await r.text();writeFileSync(resolve(output,endpoint.endsWith('status')?'status.json':'ready.json'),raw,{flag:'wx',mode:0o600});receipt.identity[endpoint]={status:r.status};}catch(e){receipt.identity[endpoint]={error:e.name}}}
for(const i of [1,2,3,0]) {
 const id=randomUUID(),start=Date.now();const item={question:`Q${i+1}`,request_id:id,transport:'HTTP',account:'sample-alex-morgan'};
 try{const response=await fetch(origin+'/chat',{method:'POST',headers:{'content-type':'application/json','X-Demo-User-Id':'alex-morgan'},body:JSON.stringify({message:questions[i],client_request_id:id}),signal:AbortSignal.timeout(320000)});const raw=await response.text();writeFileSync(resolve(output,`Q${i+1}.raw.json`),raw,{flag:'wx',mode:0o600});const body=JSON.parse(raw);Object.assign(item,{status:response.status,session_id:body.session_id,confidence:body.confidence,route:body.response_route,attempts:body.qualification_attempts,model_identity:body.runtime_identity,ms:Date.now()-start});console.log(item.question,item.status,item.confidence,item.ms);}
 catch(e){Object.assign(item,{error:e.code||e.name,ms:Date.now()-start});console.log(item.question,item.error)}
 receipt.questions.push(item);writeFileSync(resolve(output,'progress.json'),JSON.stringify(receipt,null,2),{mode:0o600});
}
writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
