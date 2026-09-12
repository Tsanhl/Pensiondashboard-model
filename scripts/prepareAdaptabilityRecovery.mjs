import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
import {requireAdaptabilityRuntimeProof} from './lib/adaptabilityRuntimeProof.mjs';
const [oldArg,newArg]=process.argv.slice(2);if(!oldArg||!newArg)throw Error('Old main and fresh recovery roots required');
const old=resolve(oldArg),root=resolve(newArg),plan=JSON.parse(readFileSync(resolve(old,'training-plan.json')));
if(existsSync(root))throw Error('Refusing existing recovery');
requireAdaptabilityRuntimeProof(plan);
for(const x of plan.bound_inputs)if(hash(x.path)!==x.sha256)throw Error('Original binding changed: '+x.path);
const exit=JSON.parse(readFileSync(resolve(old,'training-exit.json'))),log=readFileSync(resolve(old,'training-output.log'),'utf8');
const updates=[...log.matchAll(/"completed_optimizer_updates": (\d+)/g)].map(x=>Number(x[1]));
if(exit.aborted!=='RESOURCE_METRICS_UNAVAILABLE'||updates.at(-1)!==23)throw Error('Not the declared interrupted main run');
const native=resolve('/Users/hltsang/.codex/private/pension-adaptability/20260912/process-footprint-native');
const probe=spawnSync(native,[String(process.pid)],{encoding:'utf8',timeout:3000});
const measured=JSON.parse(probe.stdout);
if(probe.status!==0||measured.pid!==process.pid||!(measured.physical_footprint_gib>0))throw Error('Native probe unavailable');
const python=spawnSync(resolve('.training-venv/bin/python'),['-I','-B',resolve('scripts/processFootprint.py'),String(process.pid)],{encoding:'utf8',timeout:10000});
const reference=JSON.parse(python.stdout);
if(python.status!==0||Math.abs(reference.physical_footprint_gib-measured.physical_footprint_gib)>0.05)throw Error('Native/kernel reference disagreement');
plan.recovery={old_root:old,updates:24,baseline_adapter:plan.parent_adapter,partial_checkpoint:resolve(old,'adapters/0000012_adapters.safetensors'),native_probe:native,
  optimizer_reset:true,parent_lineage_updates:12,discarded_confirmed_updates:11,maximum_total_confirmed_main_work:47,maximum_weight_lineage_updates:36};
plan.train={...plan.train,iters:24,adapter_path:resolve(root,'segment-adapters')};
const paths=[resolve(old,'training-plan.json'),resolve(old,'training-exit.json'),resolve(old,'training-output.log'),plan.recovery.partial_checkpoint,
  resolve('docs/live-repair/INTERRUPTED-MAIN-RECOVERY-20260912.md'),resolve('scripts/processFootprintNative.c'),native,
  resolve('scripts/prepareAdaptabilityRecovery.mjs'),resolve('scripts/runAdaptabilityRecovery.mjs'),resolve('ml/recover_adaptability.py')];
plan.bound_inputs.push(...paths.map(path=>({path,sha256:hash(path)})));
mkdirSync(root,{mode:0o700});mkdirSync(resolve(root,'reconstructed-parent'));mkdirSync(resolve(root,'durable-updates'));
copyFileSync(resolve(old,'training.sb'),resolve(root,'training.sb'));
copyFileSync(resolve(old,'adapters/adapter_config.json'),resolve(root,'reconstructed-parent/adapter_config.json'));
writeFileSync(resolve(root,'training-plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'native-probe-test.json'),JSON.stringify({passed:true,measured,reference,probe_sha256:hash(native)}),{flag:'wx',mode:0o600});
const result=spawnSync('/usr/bin/sandbox-exec',['-f',resolve(root,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/recover_adaptability.py'),root,'prepare'],{encoding:'utf8',timeout:60000});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.status!==0)throw Error('CPU-only reconstruction failed; no model launched');
console.log(JSON.stringify({root,prepared:true,model_started:false}));
