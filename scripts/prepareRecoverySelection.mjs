import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw Error('Recovery root required');
const plan=JSON.parse(readFileSync(resolve(root,'training-plan.json')));
if(!plan.recovery)throw Error('Recovery plan required');
const paths=[resolve(root,'training-plan.json'),resolve('scripts/prepareRecoverySelection.mjs'),resolve('scripts/runAdaptabilitySelection.mjs'),resolve('ml/evaluate_adaptability_checkpoints.py'),resolve('scripts/finalizeAdaptabilityRecovery.mjs'),resolve('scripts/lib/adaptabilityDurationSelection.mjs'),resolve('scripts/lib/adaptabilitySelectionControls.mjs'),resolve('scripts/lib/qualification-worker/aiReview.mjs'),resolve('config/qualification-worker.json')];
writeFileSync(resolve(root,'selection-binding.json'),JSON.stringify({created_at:new Date().toISOString(),scope:'DEVELOPMENT_RECOVERY_VALIDATION_ONLY',candidate_lineage_updates:[0,12,24,36],maximum_generations:32,maximum_tokens_per_generation:192,maximum_reviewer_calls:8,static_calibration_controls_per_packet:2,maximum_model_seconds:7200,automatic_retries:0,bound_inputs:paths.map(path=>({path,sha256:hash(path)}))},null,2),{flag:'wx',mode:0o600});
console.log('Recovery selection bindings recorded; no model or reviewer started');
