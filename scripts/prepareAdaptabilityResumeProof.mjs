import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [sourceArg,rootArg]=process.argv.slice(2);if(!sourceArg||!rootArg)throw Error('Source recovery and fresh proof root required');
const sourceRoot=resolve(sourceArg),root=resolve(rootArg);
if(existsSync(root))throw Error('Fresh output required');
const source=JSON.parse(readFileSync(resolve(sourceRoot,'training-plan.json')));
for(const item of source.bound_inputs)if(hash(item.path)!==item.sha256)throw Error('Historical bound input changed: '+item.path);
const cpu=spawnSync('/usr/bin/sandbox-exec',['-f',resolve(sourceRoot,'training.sb'),resolve('.training-venv/bin/python'),'-I','-B',resolve('ml/test_adaptability_resume.py')],{encoding:'utf8',timeout:60000});
if(cpu.status!==0)throw Error('CPU exact-resume test failed: '+cpu.stderr);
const receipt=JSON.parse(cpu.stdout);if(!receipt.model_optimizer_rng_bit_exact||!receipt.fresh_process_resume)throw Error('Incomplete CPU equivalence');
const files=['ml/adaptability_resume.py','ml/test_adaptability_resume.py','ml/prove_adaptability_resume.py',
  'scripts/prepareAdaptabilityResumeProof.mjs','scripts/runAdaptabilityResumeProof.mjs','scripts/lib/adaptabilityTelemetry.mjs'];
const smoke=resolve('/Users/hltsang/.codex/private/pension-adaptability/20260912/run-v3-four-layer/smoke-data');
mkdirSync(root,{mode:0o700});copyFileSync(resolve(sourceRoot,'training.sb'),resolve(root,'training.sb'));
writeFileSync(resolve(root,'cpu-equivalence.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
const plan={version:'resume-state-proof-v1',classification:'DISPOSABLE_RUNTIME_DEVELOPMENT_ONLY',
  owner_authorized_training:true,authority:'Current user explicitly requested resource/resume repairs and bounded training/comparison. This is one new changed-workload diagnostic, not an automatic retry of the interrupted main run.',
  maximum_attempts:1,maximum_disposable_updates:2,maximum_generations:1,maximum_generation_tokens:192,
  preserve_checkpoint:104,automatic_retry:false,main_training_authorized_by_this_plan:false,
  source,smoke_data:smoke,native_probe:source.recovery.native_probe,
  versions:{mlx:'0.32.2','mlx-lm':'0.31.3',transformers:'5.16.1'},
  resource_limits:{...source.resource_limits,total_seconds:1800},
  bound_inputs:[...source.bound_inputs,...files.map(path=>({path:resolve(path),sha256:hash(resolve(path))})),
    ...['training.sb','cpu-equivalence.json'].map(name=>({path:resolve(root,name),sha256:hash(resolve(root,name))}))]};
writeFileSync(resolve(root,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,plan_sha256:hash(resolve(root,'plan.json')),cpu_equivalence:receipt.passed,model_started:false,maximum_disposable_updates:2}));
