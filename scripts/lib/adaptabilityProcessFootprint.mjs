import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
export function processFootprintGiB(pid) {
 const result=spawnSync(resolve('.training-venv/bin/python'),['-I','-B',resolve('scripts/processFootprint.py'),String(pid)],{encoding:'utf8',timeout:3000});
 if(result.status!==0)return NaN;
 try {const value=JSON.parse(result.stdout);return value.pid===pid?value.physical_footprint_gib:NaN;}catch{return NaN;}
}
