"""Sequential validation-only generation from exact saved adapters; no targets in prompts."""
import hashlib
import json
from pathlib import Path
import sys
import time

def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

root=Path(sys.argv[1]).resolve(strict=True)
plan=json.loads((root/'training-plan.json').read_text())
recovery=bool(plan.get('recovery'))
partial=bool(plan.get('partial_assessment'))
if recovery:
    for bound in json.loads((root/'selection-binding.json').read_text())['bound_inputs']:
        if digest(bound['path'])!=bound['sha256']:raise ValueError('Selection binding changed')
if partial:
    exit_receipt=json.loads(Path(plan['partial_assessment']['interrupted_exit']).read_text())
    if exit_receipt.get('aborted')!='SWAP_GROWTH_LIMIT':raise ValueError('Declared interrupted source required')
else:
    exit_receipt=json.loads((root/('recovery-exit.json' if recovery else 'training-exit.json')).read_text())
    if exit_receipt['exit_code']!=0 or exit_receipt.get('aborted'):raise ValueError('Completed main trajectory required')
for bound in plan['bound_inputs']:
    if digest(bound['path'])!=bound['sha256']:raise ValueError('Training input changed')
output=root/'validation-generation'
output.mkdir(mode=0o700,exist_ok=False)
import mlx.core as mx
from mlx_lm import load,stream_generate
from mlx_lm.sample_utils import make_sampler
from mlx.utils import tree_flatten
mx.set_cache_limit(256*1024*1024)
model,tokenizer=load(plan['base_path'],adapter_path=str(Path(plan['parent_adapter']).parent),tokenizer_config={'trust_remote_code':False})
model.eval()
rows=[json.loads(line) for line in (Path(plan['dataset'])/'valid.jsonl').read_text().splitlines()]
if len(rows)!=8:raise ValueError('Exactly eight validation examples required')
results=[]
loss_records=[]
if recovery:
    if not partial:
        completion=json.loads((root/'recovery-completion.json').read_text())
        if completion['segment_updates']!=24 or completion['weight_lineage_updates']!=36:raise ValueError('Recovery incomplete')
    import importlib.util
    def local_module(name,filename):
        spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
        value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
    original=local_module('training_original','train_adaptability.py')
    loss_module=local_module('target_loss','assistant_target_loss.py')
    validation=local_module('validation_host','adaptability_validation.py')
    from mlx_lm.tuner.datasets import load_dataset
    from mlx_lm.tuner.trainer import CacheDataset
    from mlx_lm.lora import CONFIG_DEFAULTS
    import types
    config={**CONFIG_DEFAULTS,**plan['hyperparameters'],**plan['train'],'mask_prompt':True,'train':True,'test':False}
    _,valid,_=load_dataset(types.SimpleNamespace(**config),original.ServingTokenizer(tokenizer))
    if len(valid)!=8:raise ValueError('Recovery full validation required')
for update in ((0,12) if partial else (0,12,24,36) if recovery else (0,12,24,36,48)):
    if update==0:adapter=Path(plan['parent_adapter'])
    elif recovery:adapter=(root/'reconstructed-parent'/'adapters.safetensors') if update==12 else root/'durable-updates'/f'{update-12:03d}'/'adapters.safetensors'
    else:adapter=Path(plan['train']['adapter_path'])/f'{update:07d}_adapters.safetensors'
    model.load_weights(str(adapter),strict=False)
    mx.eval(model.parameters())
    expected=mx.load(str(adapter));actual=dict(tree_flatten(model.parameters()))
    if not all(k in actual and mx.array_equal(v,actual[k]).item() for k,v in expected.items()):raise ValueError('Loaded candidate mismatch')
    candidate_hash=digest(adapter)
    if recovery:
        exact_loss=float(validation.evaluate(model,CacheDataset(valid),batch_size=1,num_batches=-1,max_seq_length=plan['hyperparameters']['max_seq_length'],loss=loss_module.assistant_target_loss))
        loss_records.append({'additional_update_count':update,'adapter_sha256':candidate_hash,'validation_loss':exact_loss})
        print(json.dumps({'event':'recovery_exact_validation',**loss_records[-1]}),flush=True)
    for row in rows:
        messages=row['messages'][:-1]
        if row['messages'][-1]['role']!='assistant':raise ValueError('Missing final target boundary')
        prompt=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True,enable_thinking=False)
        mx.random.seed(42)
        start=time.monotonic();raw='';last=None
        print(json.dumps({'event':'generation_start','update':update,'id':row['metadata']['training_id']}),flush=True)
        for response in stream_generate(model,tokenizer,prompt,max_tokens=192,sampler=make_sampler(temp=0)):
            raw+=response.text;last=response
        result={'additional_update_count':update,'id':row['metadata']['training_id'],'adapter_sha256':candidate_hash,'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'raw':raw,'finish_reason':last.finish_reason if last else None,'generation_tokens':last.generation_tokens if last else 0,'seconds':time.monotonic()-start,'peak_gb':mx.get_peak_memory()/1e9,'scope':'VALIDATION_REPLAY_SELECTION_ONLY'}
        (output/f'{update}-{result["id"]}.json').write_text(json.dumps(result,indent=2))
        results.append(result)
        print(json.dumps({'event':'generation_completed',**{k:v for k,v in result.items() if k!='raw'}}),flush=True)
        mx.clear_cache()
        if result['peak_gb']>plan['memory_limit_gb']:raise RuntimeError('Generation resource ceiling')
(output/'receipt.json').write_text(json.dumps({'validation_sha256':digest(Path(plan['dataset'])/'valid.jsonl'),'results':results,'completed_generations':len(results),'exact_loss_records':loss_records,'partial_interrupted_study':partial,'recovery_optimizer_reset':recovery and not partial,'semantic_assessment':'PENDING_INDEPENDENT_REVIEW'},indent=2))
