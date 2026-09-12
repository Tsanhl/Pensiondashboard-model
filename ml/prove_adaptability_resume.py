"""Two disposable full-context updates across fresh processes; never promotion.

Uses the existing reviewed smoke examples and retains the complete parent adapter.
Old checkpoints lacking sampler/RNG state are deliberately not accepted.
"""
from functools import partial
from contextlib import nullcontext
import importlib.metadata
import json
from pathlib import Path
import random
import sys
import types
sys.path.insert(0,str(Path(__file__).parent))
from adaptability_resume import BatchOneSampler,digest,save_checkpoint,load_checkpoint,restore_rng
from adaptability_trainables import restrict_trainables,complete_adapter
from assistant_target_loss import assistant_target_loss,validate_target_window
from train_adaptability import ServingTokenizer
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm import load,stream_generate
from mlx_lm.sample_utils import make_sampler
from mlx_lm.lora import CONFIG_DEFAULTS
from mlx_lm.tuner.datasets import load_dataset
from mlx_lm.tuner.trainer import grad_checkpoint,CacheDataset
from adaptability_validation import evaluate
import numpy as np

root=Path(sys.argv[1]).resolve(strict=True);phase=sys.argv[2]
plan=json.loads((root/'plan.json').read_text())
segment=plan.get('checkpointed_segment')
bounded_memory=bool(segment and segment.get('memory_strategy')=='frozen-prefix-query128')
if bounded_memory:
    from adaptability_memory import frozen_prefix,suffix_target_loss,query_chunked_qwen3
maximum=segment['maximum_updates'] if segment else 2
main_mode=bool(segment and segment['mode']=='main')
if maximum not in ((12,) if main_mode else (2,)) or phase not in ([str(i) for i in range(1,maximum+1)]+['verify']) or not plan['owner_authorized_training']:
    raise ValueError('Explicit bounded resume proof required')
if main_mode:
    proof=json.loads(Path(plan['runtime_proof']['result_path']).read_text())
    if proof['status']!='RUNTIME_RESUME_PROOF_COMPLETE' or proof.get('failed') or proof.get('workload_identity')!=plan['workload_identity']:
        raise ValueError('Compatible complete proof required')
for item in plan['bound_inputs']:
    if digest(item['path'])!=item['sha256']:raise ValueError('Changed proof input: '+item['path'])
for name,version in plan['versions'].items():
    if importlib.metadata.version(name)!=version:raise ValueError('Runtime version changed')
if (root/f'phase-{phase}.json').exists():raise ValueError('Phase already completed')
source=plan['source'];identity={'plan_sha256':digest(root/'plan.json')}
mx.set_cache_limit(256*1024*1024)
if mx.metal.is_available():mx.set_wired_limit(mx.device_info()['max_recommended_working_set_size'])
mx.random.seed(42);np.random.seed(42);random.seed(42)
def event(stage,**values):
    print(json.dumps({'event':'resume_proof_stage','phase':phase,'stage':stage,
        'mlx_active_gb':mx.get_active_memory()/1e9,'mlx_cache_gb':mx.get_cache_memory()/1e9,
        'mlx_peak_gb':mx.get_peak_memory()/1e9,**values}),flush=True)
event('load')
model,tokenizer=load(source['base_path'],adapter_path=plan.get('parent_config_directory',str(Path(source['parent_adapter']).parent)),tokenizer_config={'trust_remote_code':False})
parent=mx.load(source['parent_adapter']);model.load_weights(list(parent.items()),strict=False);actual=dict(tree_flatten(model.parameters()))
if len(parent)!=224:raise ValueError('Expected full sixteen-layer parent adapter')
if not all(k in actual and mx.array_equal(actual[k],v).item() for k,v in parent.items()):raise ValueError('Parent adapter mismatch')
del actual
args=types.SimpleNamespace(**{**CONFIG_DEFAULTS,**source['hyperparameters'],**source['train'],
    'data':plan['smoke_data'],'max_seq_length':segment['max_seq_length'] if segment else source['hyperparameters']['max_seq_length'],'mask_prompt':True,'train':True,'test':False})
train,valid,_=load_dataset(args,ServingTokenizer(tokenizer))
data=[train.process(train[i]) for i in range(len(train))]
if len(data)!=(24 if main_mode else 2) or len(valid)!=8 or max(len(x[0]) for x in data)!=(segment['expected_longest_tokens'] if segment else 3292):raise ValueError('Full-context data shape mismatch')
for tokens,offset in data:validate_target_window(len(tokens),offset,args.max_seq_length)
model.freeze()
# Unfreeze only actual LoRA modules, not dotted parameter names or base weights.
for layer in model.layers:
    for _,module in layer.named_modules():
        if hasattr(module,'lora_a') and hasattr(module,'lora_b'):module.unfreeze(keys=['lora_a','lora_b'],recurse=False)
trainable_layers=segment.get('trainable_layers',4) if segment else 4
if trainable_layers not in (2,4):raise ValueError('Undeclared trainable layer configuration')
if segment and plan['workload']['trainable_layers']!=trainable_layers:raise ValueError('Trainable workload mismatch')
selected=restrict_trainables(model,trainable_layers)
if len(selected)!=14*trainable_layers or not set(selected).issubset(parent):raise ValueError('Trainable subset mismatch')
optimizer=optim.Adam(1e-5);sampler=BatchOneSampler(data,args.max_seq_length,seed=42)
start=maximum if phase=='verify' else int(phase)-1;checkpoint=None
if start:
    checkpoint=root/'checkpoints'/str(start)
    if segment:
        prior=json.loads((root/f'phase-{start}.json').read_text())
        if digest(checkpoint/'complete.json')!=prior['checkpoint_metadata_sha256']:raise ValueError('Checkpoint metadata changed')
    adapter,state,sampler,metadata=load_checkpoint(checkpoint,identity=identity,dataset=data,max_seq_length=args.max_seq_length)
    if set(adapter)!=set(parent):raise ValueError('Incomplete restored adapter')
    for name,value in adapter.items():
        if value.shape!=parent[name].shape or value.dtype!=parent[name].dtype:raise ValueError('Adapter shape mismatch')
        if name not in selected and not mx.array_equal(value,parent[name]).item():raise ValueError('Frozen adapter changed')
    model.load_weights(list(adapter.items()),strict=False);optimizer.state=state['optimizer'];restore_rng(state,metadata)
    event('restored',completed_updates=start,sampler_cursor=sampler.cursor)
if phase=='verify':
    model.eval();event('full_validation')
    score=float(evaluate(model,CacheDataset(valid),batch_size=1,num_batches=-1,max_seq_length=args.max_seq_length,loss=assistant_target_loss))
    if not np.isfinite(score):raise ValueError('Nonfinite validation')
    rows=[json.loads(line) for line in (Path(plan['smoke_data'])/'valid.jsonl').read_text().splitlines()]
    messages=rows[0]['messages'][:-1]
    prompt=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True,enable_thinking=False)
    event('generation');raw='';last=None
    for response in stream_generate(model,tokenizer,prompt,max_tokens=192,sampler=make_sampler(temp=0)):
        raw+=response.text;last=response
    if not last or last.finish_reason!='stop':raise ValueError('Reload generation did not stop normally')
    result={'phase':phase,'completed_updates':maximum,'fresh_process_reload':True,'full_validation_loss':score,
        'validation_items':8,'raw_generation':raw,'finish_reason':last.finish_reason if last else None,
        'formal_credit':False,'promotion':False,'semantic_assessment':'NOT_PERFORMED'}
else:
    grad_checkpoint(model.layers[0]);model.train();event('compile_and_update')
    batch,index=next(sampler)
    hidden=None
    if bounded_memory:
        hidden=frozen_prefix(model,batch[0],trainable_layers,
            progress=lambda i,n:event('compile_and_update',operation='frozen_prefix',layer=i,layers=n))
        event('compile_and_update',operation='trainable_tail')
    state=[model.state,optimizer.state,mx.random.state]
    loss_fn=(lambda m,h,x,l:suffix_target_loss(m,h,x,l,trainable_layers)) if bounded_memory else assistant_target_loss
    vg=nn.value_and_grad(model,loss_fn)
    @partial(mx.compile,inputs=state,outputs=state)
    def step(batch,lengths,hidden):
        (value,tokens),gradient=vg(model,hidden,batch,lengths) if bounded_memory else vg(model,batch,lengths)
        finite=mx.stack([mx.all(mx.isfinite(v)) for _,v in tree_flatten(gradient)]).all()
        optimizer.update(model,gradient)
        return value,tokens,finite
    with query_chunked_qwen3(128) if bounded_memory else nullcontext():
        value,tokens,finite=step(*batch,hidden);mx.eval(state,value,tokens,finite)
    if not finite.item() or not mx.isfinite(value).item():raise ValueError('Nonfinite gradient/loss; discard update')
    if int(optimizer.step.item())!=start+1:raise ValueError('Update accounting mismatch')
    changed=dict(tree_flatten(model.trainable_parameters()));full=complete_adapter(parent,changed,selected)
    if not any(not mx.array_equal(v,parent[k]).item() for k,v in changed.items()):raise ValueError('Adapter did not change')
    event('save',completed_updates=start+1,tokens=int(tokens.item()),example_index=index,loss=float(value.item()))
    saved=save_checkpoint(root/'checkpoints'/str(start+1),adapter=full,optimizer_state=optimizer.state,
        sampler=sampler,identity=identity,completed_updates=start+1)
    result={'phase':phase,'completed_updates':start+1,'example_index':index,'loss':float(value.item()),
        'checkpoint_hashes':saved['hashes'],'checkpoint_metadata_sha256':digest(root/'checkpoints'/str(start+1)/'complete.json'),
        'input_tokens':len(data[index][0]),'supervised_tokens':len(data[index][0])-data[index][1],
        'frozen_adapter_tensors_unchanged':True,'finite_gradients':True,'formal_credit':False}
result['main_updates_added']=start+1 if main_mode and phase!='verify' else (maximum if main_mode else 0)
result['segment_mode']='main' if main_mode else 'disposable'
result['trainable_layers']=trainable_layers
result['trainable_tensors']=len(selected)
result['memory_strategy']=segment.get('memory_strategy','legacy') if segment else 'legacy'
result['optimizer_reset_at_segment_start']=bool(segment)
mx.clear_cache();event('complete',**result)
if mx.get_peak_memory()/1e9>plan['resource_limits']['mlx_peak_max_decimal_gb']:raise ValueError('MLX memory limit')
with (root/f'phase-{phase}.json').open('x') as stream:json.dump(result,stream,indent=2)
