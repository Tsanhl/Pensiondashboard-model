// System counters establish temporal correlation, not per-process swap attribution.
import {spawnSync} from 'node:child_process';

export function parseVmStat(text) {
  const page=Number(String(text).match(/page size of (\d+) bytes/)?.[1]);
  const counter=name=>Number(String(text).match(new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm'))?.[1]);
  const value={page_bytes:page,swapins:counter('Swapins'),swapouts:counter('Swapouts'),
    compressor_pages:counter('Pages occupied by compressor')};
  if(Object.values(value).some(x=>!Number.isFinite(x)||x<0)||page===0)throw Error('Invalid vm_stat counters');
  return value;
}

export function vmDelta(previous,current) {
  if(!previous)return {available:false,reason:'FIRST_SAMPLE'};
  const seconds=(current.monotonic_ms-previous.monotonic_ms)/1000;
  if(!(seconds>0)||previous.page_bytes!==current.page_bytes||current.swapins<previous.swapins||current.swapouts<previous.swapouts)
    return {available:false,reason:'COUNTER_RESET_OR_INVALID_INTERVAL'};
  return {available:true,seconds,swapin_mib_per_second:(current.swapins-previous.swapins)*current.page_bytes/1048576/seconds,
    swapout_mib_per_second:(current.swapouts-previous.swapouts)*current.page_bytes/1048576/seconds,
    attribution:'SYSTEM_WIDE_NOT_PROCESS_SPECIFIC'};
}

export function collectTelemetry({pid,nativeProbe,initialSwap,previousVm,stage=null}) {
  const probes={};
  function run(name,command,args){
    const start=performance.now();
    const value=spawnSync(command,args,{encoding:'utf8',timeout:3000,maxBuffer:65536});
    probes[name]={exit_code:value.status,signal:value.signal,error:value.error?.code??null,stderr:value.stderr??'',milliseconds:performance.now()-start};
    return value.status===0?value.stdout:'';
  }
  const swap=run('swap','/usr/sbin/sysctl',['vm.swapusage']);
  const free=run('free','/usr/bin/memory_pressure',['-Q']);
  const rawVm=run('vm','/usr/bin/vm_stat',[]);
  let vm=null;try{vm={...parseVmStat(rawVm),monotonic_ms:performance.now()};}catch{}
  let footprint=null;
  if(pid){try{const value=JSON.parse(run('footprint',nativeProbe,[String(pid)]));if(value.pid===pid)footprint=value;}catch{}}
  const used=Number(swap.match(/used = ([\d.]+)M/)?.[1]);
  return {at:new Date().toISOString(),stage,swap_used_mb:used,swap_delta_mb:used-initialSwap,
    system_free_percent:Number(free.match(/free percentage:\s*(\d+)/)?.[1]),
    physical_footprint_gib:footprint?.physical_footprint_gib??NaN,
    vm,vm_delta:vm?vmDelta(previousVm,vm):{available:false,reason:'METRICS_UNAVAILABLE'},probes};
}
