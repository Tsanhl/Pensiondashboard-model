import {validateResourceLimits,resourceLimitViolation,footprintGiB} from './lib/adaptabilityResourceLimits.mjs';
import {processFootprintGiB} from './lib/adaptabilityProcessFootprint.mjs';
import {readFileSync,writeFileSync,createWriteStream,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {boundedFileDigest} from './lib/boundedFileDigest.mjs';
if(process.argv[2]==='--check-proposal') {
 const proposal=JSON.parse(readFileSync(resolve(process.argv[3])));
 if(proposal.status!=='AWAITING_OWNER_RESOURCE_APPROVAL'||proposal.full_model_attempts!==1||proposal.disposable_updates!==2)throw Error('Not a bounded unapproved proposal');
 validateResourceLimits(proposal.limits);
 for(const input of proposal.bound_inputs)if(boundedFileDigest(input.path)!==input.sha256)throw Error('Proposal input changed: '+input.path);
 console.log(JSON.stringify({proposal_valid:true,owner_approval:false,child_started:false,full_model_attempts:0}));
 process.exit(0);
}
const bindingPath=resolve(process.argv[2]||'');
if(!process.argv[2])throw Error('Explicit diagnostic binding required');
const binding=JSON.parse(readFileSync(bindingPath));
for(const input of binding.bound_inputs)if(boundedFileDigest(input.path)!==input.sha256)throw Error('Diagnostic binding mismatch');
const root=dirname(bindingPath),logPath=resolve(root,'diagnostic-output.jsonl');
if(existsSync(logPath)||existsSync(binding.output))throw Error('Diagnostic already started; no automatic restart');
const isolation=spawnSync('/usr/bin/sandbox-exec',['-f',binding.profile,'/bin/cat',resolve('training/evaluation-cycle-v2/30-cumulative-legal-training-20260902/checkpoint-selection.json')],{encoding:'utf8',timeout:5000});
if(isolation.status===0)throw Error('Protected-tree isolation failed');
const log=createWriteStream(logPath,{flags:'wx',mode:0o600});
const metrics=createWriteStream(resolve(root,'resource-metrics.jsonl'),{flags:'wx',mode:0o600});
const started=Date.now();let stage='startup',stageStarted=started,reason=null,pending='',updates=0;
const swap=()=>Number(spawnSync('/usr/sbin/sysctl',['vm.swapusage'],{encoding:'utf8',timeout:3000}).stdout?.match(/used = ([\d.]+)M/)?.[1]??NaN);
const initialSwap=swap();
if(binding.resource_limits){
 validateResourceLimits(binding.resource_limits);
 const pressure=spawnSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8',timeout:3000}).stdout||'';
 const reason=resourceLimitViolation(binding.resource_limits,{swap_used_mb:initialSwap,system_free_percent:Number(pressure.match(/free percentage:\s*(\d+)/)?.[1]??NaN)},{prestart:true});
 if(reason)throw Error('No diagnostic child launched: '+reason);
}
const child=spawn('/usr/bin/sandbox-exec',['-f',binding.profile,resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/diagnose_adaptability_runtime.py'),bindingPath],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,PYTHONUNBUFFERED:'1',HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},detached:true,stdio:['ignore','pipe','pipe']});
writeFileSync(resolve(root,'process-ownership.json'),JSON.stringify({pid:child.pid,supervisor_pid:process.pid,started_at:new Date(started).toISOString(),binding_sha256:boundedFileDigest(bindingPath),command:'isolated disposable diagnostic',main_updates:0},null,2),{flag:'wx',mode:0o600});
const stop=why=>{if(reason)return;reason=why;try{process.kill(-child.pid,'SIGTERM')}catch{};setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},5000).unref();};
const interrupt=()=>stop('OWNER_OR_SUPERVISOR_INTERRUPT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);pending+=bytes;const lines=pending.split('\n');pending=lines.pop();for(const line of lines){try{const e=JSON.parse(line);if(e.event==='stage_start'){stage=e.stage;stageStarted=Date.now();}if(e.event==='update_completed')updates=e.update;if(e.peak_gb>(binding.resource_limits?.mlx_peak_max_decimal_gb||14))stop('DEVICE_PEAK_LIMIT');}catch{}}});
child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
const timer=setInterval(()=>{
 const now=Date.now(),budget=binding.stage_timeout_seconds[stage]||90;
 if(now-started>binding.timeout_seconds*1000)stop('TOTAL_TIMEOUT');
 if(now-stageStarted>budget*1000)stop('STAGE_TIMEOUT:'+stage);
 const rss=spawnSync('/bin/ps',['-o','pid=,rss=,%cpu=,etime=,state=','-p',String(child.pid)],{encoding:'utf8',timeout:3000}).stdout.trim();
 const usedSwap=swap(),pressure=spawnSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8',timeout:3000}).stdout||'';
 const free=Number(pressure.match(/free percentage:\s*(\d+)/)?.[1]??(binding.resource_limits?NaN:100));
 const footprint=binding.resource_limits?processFootprintGiB(child.pid):null;
 metrics.write(JSON.stringify({physical_footprint_gib:Number.isFinite(footprint)?footprint:null,at:new Date().toISOString(),stage,stage_elapsed_ms:now-stageStarted,updates,process:rss,swap_used_mb:usedSwap,swap_delta_mb:usedSwap-initialSwap,system_free_percent:free})+'\n');
 if(binding.resource_limits){
  const violation=resourceLimitViolation(binding.resource_limits,{swap_used_mb:usedSwap,swap_delta_mb:usedSwap-initialSwap,system_free_percent:free,physical_footprint_gib:footprint});
  if(violation)stop(violation);
 } else if(usedSwap-initialSwap>2048||free<10)stop('HOST_MEMORY_PRESSURE_LIMIT');
},5000);
const result=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({exit_code:code,signal}));});
clearInterval(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
await Promise.all([new Promise(r=>log.end(r)),new Promise(r=>metrics.end(r))]);
const receipt={...result,abort_reason:reason,started_at:new Date(started).toISOString(),ended_at:new Date().toISOString(),last_stage:stage,updates_confirmed:updates,main_updates:0,formal_credit:false,binding_sha256:boundedFileDigest(bindingPath)};
writeFileSync(resolve(root,'exit.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify(receipt));if(result.exit_code!==0||result.signal||reason)process.exitCode=1;
