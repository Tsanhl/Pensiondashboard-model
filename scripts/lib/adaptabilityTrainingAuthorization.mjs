import {readFileSync} from 'node:fs';
import {boundedFileDigest} from './boundedFileDigest.mjs';
export function loadTrainingAuthorization(path) {
 const value=JSON.parse(readFileSync(path));
 if(value.owner_authorized_training!==true||value.training_execution_authorized!==true||value.main_trajectories!==1||value.main_update_cap!==48||value.disposable_updates!==2)throw Error('Applicable bounded training authority required');
 return {...value,receipt_path:path,receipt_sha256:boundedFileDigest(path)};
}
