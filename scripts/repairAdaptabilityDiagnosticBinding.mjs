// Fresh infrastructure-repair attempt, preserving every earlier plan/binding/exit.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [previousPath,destination,reason]=process.argv.slice(2);
if(!previousPath||!destination||!reason)throw Error('Prior binding, fresh destination, explicit repair reason required');
const previous=JSON.parse(readFileSync(previousPath)),exit=JSON.parse(readFileSync(resolve(dirname(previousPath),'exit.json')));
if(exit.updates_confirmed!==0||!['RESOURCE_METRICS_UNAVAILABLE',null].includes(exit.abort_reason))throw Error('Not a zero-update infrastructure repair');
if(existsSync(destination))throw Error('Fresh output only');
mkdirSync(destination,{mode:0o700});
const next={...previous,output:resolve(destination,'quarantined-adapter'),previous_binding_path:resolve(previousPath),previous_binding_sha256:hash(previousPath),infrastructure_repair:reason};
const allowedChanges=new Set(['ml/diagnose_adaptability_runtime.py','scripts/diagnoseAdaptabilityRuntime.mjs','scripts/processFootprint.py','scripts/lib/adaptabilityProcessFootprint.mjs'].map(x=>resolve(x)));
next.bound_inputs=previous.bound_inputs.map(x=>{
 const sha256=hash(x.path);
 if(sha256!==x.sha256&&!allowedChanges.has(resolve(x.path)))throw Error('Infrastructure rebind may not change data, model, plan, reviews or authority: '+x.path);
 return {path:x.path,sha256};
});
writeFileSync(resolve(destination,'binding.json'),JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({binding:resolve(destination,'binding.json'),child_started:false}));
