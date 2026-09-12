import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
// Opt-in owner-development evidence only. Disabled in qualification; no secrets
// or internal reasoning. HTTP clients cannot enable or select this destination.
export function writeDevelopmentTrace(requestId,value) {
 const root=process.env.PENSION_DEVELOPMENT_TRACE_ROOT;
 if(!root||process.env.QUALIFICATION_RUNTIME_MODE==='true')return;
 if(!isAbsolute(root))throw Error('Development trace directory must be absolute');
 mkdirSync(root,{recursive:true,mode:0o700});
 const id=createHash('sha256').update(String(requestId)).digest('hex');
 const safe={...value,generated:value.generated?{...value.generated,rawContent:String(value.generated.rawContent||'').replace(/<think>[\s\S]*?<\/think>/gi,'[reasoning omitted]')}:undefined};
 writeFileSync(resolve(root,id+'.json'),JSON.stringify({classification:'DEVELOPMENT_ONLY',request_id:requestId,...safe},null,2),{flag:'wx',mode:0o600});
}
