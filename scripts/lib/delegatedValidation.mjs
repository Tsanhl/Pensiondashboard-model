import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
// Only the stage watchdog changes. Optimizer phases, model launcher and all
// memory checks remain byte-identical to the already proven supervisor.
export function delegatedValidationSupervisor(source,projectRoot){
 const before='stageDeadlineExceeded(stage.stage,Date.now()-stageStarted,plan.stage_seconds)';
 if(source.split(before).length!==2)throw Error('Supervisor template changed; review before delegation');
 return source.replace(before,'stageDeadlineExceeded(stage.stage,Date.now()-stageStarted,{...plan.stage_seconds,full_validation:420})')
  .replace(/from '(\.\/lib\/[^']+)'/g,(_,p)=>`from '${pathToFileURL(resolve(projectRoot,'scripts',p)).href}'`);
}
