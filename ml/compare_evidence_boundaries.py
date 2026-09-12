"""Frozen current-product prompts with existing validation sources, never targets."""
import hashlib
import json
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).parent))
root=Path(sys.argv[1]).resolve(strict=True)
def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
plan=json.loads((root/'plan.json').read_text());cases=json.loads((root/'cases.json').read_text())
for item in plan['bound_inputs']:
    if digest(item['path'])!=item['sha256']:raise ValueError('Comparison input changed')
if len(cases)!=8 or len(plan['candidates']) not in (2,3) or plan['maximum_generations']!=8*len(plan['candidates']):raise ValueError('Comparison budget mismatch')
if plan.get('temperature',0) not in (0,0.1) or plan['maximum_tokens'] not in (256,320):raise ValueError('Unbound decoding envelope')
out=root/'generation';out.mkdir(mode=0o700)
import mlx.core as mx
from mlx_lm import load,stream_generate
from mlx_lm.sample_utils import make_sampler
from mlx.utils import tree_flatten
mx.set_cache_limit(256*1024*1024)
model,tokenizer=load(plan['base_path'],adapter_path=str(Path(plan['candidates'][0]['path']).parent),tokenizer_config={'trust_remote_code':False})
model.eval();results=[];losses=[]
if plan.get('validation_dataset'):
    from train_adaptability import ServingTokenizer
    from assistant_target_loss import assistant_target_loss,validate_target_window
    from adaptability_validation import evaluate
    from mlx_lm.tuner.datasets import ChatDataset
    from mlx_lm.tuner.trainer import CacheDataset
    valid_rows=[json.loads(x) for x in (Path(plan['validation_dataset'])/'valid.jsonl').read_text().splitlines()]
    if len(valid_rows)!=8:raise ValueError('Validation partition changed')
    valid=ChatDataset(valid_rows,ServingTokenizer(tokenizer),mask_prompt=True)
    for row in valid_rows:
        tokens,offset=valid.process(row);validate_target_window(len(tokens),offset,3680)
for candidate in plan['candidates']:
    expected=mx.load(candidate['path']);model.load_weights(list(expected.items()),strict=False);mx.eval(model.parameters())
    actual=dict(tree_flatten(model.parameters()))
    if len(expected)!=224 or not all(k in actual and mx.array_equal(v,actual[k]).item() for k,v in expected.items()):raise ValueError('Candidate identity mismatch')
    del actual,expected
    if plan.get('validation_dataset'):
        value=float(evaluate(model,CacheDataset(valid),batch_size=1,num_batches=-1,max_seq_length=3680,loss=assistant_target_loss))
        import math
        if not math.isfinite(value):raise ValueError('Nonfinite candidate validation')
        losses.append({'candidate':candidate['id'],'adapter_sha256':candidate['sha256'],'validation_loss':value,'items':8})
        mx.clear_cache()
    for case in cases:
        if case['messages'][-1]['role']!='user':raise ValueError('Target leaked into prompt')
        prompt=tokenizer.apply_chat_template(case['messages'],tokenize=False,add_generation_prompt=True,enable_thinking=False)
        mx.random.seed(42);start=time.monotonic();raw='';last=None
        print(json.dumps({'event':'comparison_start','candidate':candidate['id'],'case':case['id']}),flush=True)
        for response in stream_generate(model,tokenizer,prompt,max_tokens=plan['maximum_tokens'],sampler=make_sampler(temp=plan.get('temperature',0))):
            raw+=response.text;last=response
        record={'candidate':candidate['id'],'id':case['id'],'adapter_sha256':candidate['sha256'],
            'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'raw':raw,'finish_reason':last.finish_reason if last else None,
            'tokens':last.generation_tokens if last else 0,'seconds':time.monotonic()-start,'peak_gb':mx.get_peak_memory()/1e9}
        with (out/(candidate['id']+'-'+case['id']+'.json')).open('x') as stream:json.dump(record,stream,indent=2)
        results.append(record);mx.clear_cache()
        print(json.dumps({'event':'comparison_completed',**{k:v for k,v in record.items() if k!='raw'}}),flush=True)
        if record['peak_gb']>plan['resource_limits']['mlx_peak_max_decimal_gb']:raise RuntimeError('MLX memory limit')
with (out/'receipt.json').open('x') as stream:json.dump({'completed_generations':len(results),'results':results,'validation_losses':losses,'formal_credit':False},stream,indent=2)
