// Preserve exact already-bound implementation bytes for historical receipts.
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,relative,dirname,sep} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const argument=process.argv[2];if(!argument)throw Error('Existing bound run root required');
const root=resolve(argument),project=resolve('.'),output=resolve(root,'code-snapshot');
if(existsSync(output))throw Error('Snapshot already exists');
const plan=JSON.parse(readFileSync(resolve(root,'plan.json')));
const allowed=['ml','scripts','server','config'].map(x=>resolve(project,x)+sep);
const files=[...new Map(plan.bound_inputs.filter(x=>allowed.some(prefix=>x.path.startsWith(prefix))).map(x=>[x.path,x])).values()];
for(const item of files)if(hash(item.path)!==item.sha256)throw Error('Bound source changed before archive: '+item.path);
mkdirSync(output,{mode:0o700});const records=[];
for(const item of files){
  const target=resolve(output,relative(project,item.path));mkdirSync(dirname(target),{recursive:true,mode:0o700});
  copyFileSync(item.path,target);if(hash(target)!==item.sha256)throw Error('Copy identity mismatch');
  records.push({...item,archived_path:target});
}
writeFileSync(resolve(output,'manifest.json'),JSON.stringify({plan_sha256:hash(resolve(root,'plan.json')),records,originals_changed:false},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,archived_code_files:records.length,originals_changed:false}));
