import {readFileSync,writeFileSync,createWriteStream,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {requireAdaptabilityRuntimeProof} from './lib/adaptabilityRuntimeProof.mjs';
import {resourceLimitViolation,footprintGiB} from './lib/adaptabilityResourceLimits.mjs';
import {processFootprintGiB} from './lib/adaptabilityProcessFootprint.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Prepared training run required');
const planPath=resolve(root,'training-plan.json');const plan=JSON.parse(readFileSync(planPath));
requireAdaptabilityRuntimeProof(plan);
const profile=resolve(root,'training.sb');
const probe=spawnSync('/usr/bin/sandbox-exec',['-f',profile,'/bin/cat',resolve('training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json')],{encoding:'utf8'});
if(probe.status===0)throw Error('Training isolation failed to deny historical/protected tree');
writeFileSync(resolve(root,'isolation-receipt.json'),JSON.stringify({scope:'TRAINING_ONLY',protected_tree_read_denied:probe.status!==0,network_denied:true,profile},null,2),{flag:'wx',mode:0o600});
async function run(mode){
 const limits=plan.resource_limits;
 const host=()=>({swap_used_mb:Number(spawnSync('/usr/sbin/sysctl',['vm.swapusage'],{encoding:'utf8',timeout:3000}).stdout?.match(/used = ([\d.]+)M/)?.[1]??NaN),system_free_percent:Number(spawnSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8',timeout:3000}).stdout?.match(/free percentage:\s*(\d+)/)?.[1]??NaN)});
 const initial=host(),prestart=resourceLimitViolation(limits,initial,{prestart:true});
 if(prestart)throw Error('No main child launched: '+prestart);
 const name=mode==='train'?'training':'smoke';const logPath=resolve(root,name+'-output.log');if(existsSync(logPath))throw Error('Refusing existing training log');
 const log=createWriteStream(logPath,{flags:'wx',mode:0o600});
 const child=spawn('/usr/bin/sandbox-exec',['-f',profile,resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/train_adaptability.py'),planPath,mode],{cwd:resolve('.'),env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,PYTHONUNBUFFERED:'1',HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},stdio:['ignore','pipe','pipe'],detached:true});
 let output='',aborted=null;const started=new Date().toISOString();
 writeFileSync(resolve(root,'training-process-ownership.json'),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,started_at:started,plan:planPath}),{flag:'wx',mode:0o600});
 const metrics=createWriteStream(resolve(root,'training-resource-metrics.jsonl'),{flags:'wx',mode:0o600});
 const kill=reason=>{if(aborted)return;aborted=reason;try{process.kill(-child.pid,'SIGTERM')}catch{};setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000).unref();};
 const resourceTimer=setInterval(()=>{const sample=host();sample.swap_delta_mb=sample.swap_used_mb-initial.swap_used_mb;sample.physical_footprint_gib=processFootprintGiB(child.pid);metrics.write(JSON.stringify({at:new Date().toISOString(),...sample})+'\n');const violation=resourceLimitViolation(limits,sample);if(violation)kill(violation);},5000);
 const stop=()=>kill('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const timer=setTimeout(()=>kill('BOUNDED_TRAINING_TIMEOUT'),mode==='smoke'?600000:7200000);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{const s=chunk.toString();output+=s;log.write(s);process.stdout.write(s);const peaks=[...s.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map(x=>Number(x[1]));if(peaks.some(x=>x>plan.memory_limit_gb))kill('MEMORY_CEILING_EXCEEDED');});
 const result=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({exit_code:code,signal}));});
 clearTimeout(timer);clearInterval(resourceTimer);process.off('SIGINT',stop);process.off('SIGTERM',stop);await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
 const peak=Math.max(0,...[...output.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map(x=>Number(x[1])));
 const receipt={mode,started_at:started,completed_at:new Date().toISOString(),...result,aborted,peak_memory_gb:peak,formal_credit:false};
 writeFileSync(resolve(root,name+'-exit.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
 if(result.exit_code!==0||result.signal||aborted||!peak||peak>plan.memory_limit_gb)throw Error(name+' failed; no automatic restart');
}
// Runtime diagnostics are separate, quarantined operations. Never promote a
// one-update canary or automatically start training after an interrupted probe.
await run('train');
