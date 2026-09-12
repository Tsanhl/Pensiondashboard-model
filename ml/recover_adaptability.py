"""Explicit weight-only recovery; never describes lost optimizer state as resumed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()

def module(name, filename):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(filename))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def write(path, value):
    with Path(path).open('x') as stream:json.dump(value,stream,indent=2)

root=Path(sys.argv[1]).resolve(strict=True)
plan=json.loads((root/'training-plan.json').read_text())
for bound in plan['bound_inputs']:
    if digest(bound['path'])!=bound['sha256']:raise ValueError('Recovery binding changed: '+bound['path'])
if plan['recovery']['updates']!=24 or plan['authorization']['owner_authorized_training'] is not True:
    raise ValueError('Explicit bounded recovery required')
import mlx.core as mx
from mlx.utils import tree_flatten
subset_module=module('subset','adaptability_trainables.py')
mx.set_default_device(mx.cpu)
parent=mx.load(plan['recovery']['baseline_adapter'])
partial=mx.load(plan['recovery']['partial_checkpoint'])
layers=sorted({int(key.split('.')[2]) for key in parent if key.startswith('model.layers.')})
if not layers:raise ValueError('Unexpected adapter layer keys')
expected={key for key in parent if key.startswith(tuple(f'model.layers.{layer}.' for layer in layers[-4:]))}
if len(expected)!=56:raise ValueError('Unexpected four-layer tensor count')
complete=subset_module.complete_adapter(parent,partial,expected)
if not all(mx.all(mx.isfinite(value)).item() for value in complete.values()):raise ValueError('Nonfinite recovery weights')
parent_path=root/'reconstructed-parent'/'adapters.safetensors'
if sys.argv[2]=='prepare':
    mx.save_safetensors(str(parent_path),complete)
    unchanged=all(mx.array_equal(complete[key],parent[key]).item() for key in parent if key not in expected)
    write(root/'reconstruction-receipt.json',{'baseline_sha256':digest(plan['recovery']['baseline_adapter']),
        'partial_sha256':digest(plan['recovery']['partial_checkpoint']),'full_sha256':digest(parent_path),
        'frozen_parent_tensors_unchanged':unchanged,'trainable_tensor_count':len(expected),
        'lineage_updates':12,'optimizer_state_recovered':False,'model_loaded':False})
    print('Reconstructed complete step12 adapter; optimizer state not recovered',flush=True)
    sys.exit(0)
if sys.argv[2]!='train':raise ValueError('Explicit prepare or train required')
receipt=json.loads((root/'reconstruction-receipt.json').read_text())
if digest(parent_path)!=receipt['full_sha256'] or not receipt['frozen_parent_tensors_unchanged']:
    raise ValueError('Reconstructed parent mismatch')
del parent,partial,complete
mx.set_default_device(mx.gpu);mx.set_cache_limit(256*1024*1024)
import numpy as np
from mlx_lm import load
import mlx_lm.lora as lora
from mlx_lm.lora import CONFIG_DEFAULTS
from mlx_lm.tuner.datasets import load_dataset
import mlx_lm.tuner.trainer as trainer
original=module('original','train_adaptability.py')
loss_module=module('target_loss','assistant_target_loss.py')
validation=module('host_validation','adaptability_validation.py')
trainer.evaluate=validation.evaluate
np.random.seed(42)
model,tokenizer=load(plan['base_path'],tokenizer_config={'trust_remote_code':False})
tokenizer=original.ServingTokenizer(tokenizer)
config=dict(CONFIG_DEFAULTS);config.update(plan['hyperparameters']);config.update(plan['train'])
config.update(model=plan['base_path'],resume_adapter_file=str(parent_path),mask_prompt=True,train=True,test=False,iters=24)
args=types.SimpleNamespace(**config)
train,valid,_=load_dataset(args,tokenizer)
if len(train)!=24 or len(valid)!=8:raise ValueError('Reviewed split mismatch')
for dataset in (train,valid):
    for index in range(len(dataset)):
        tokens,offset=dataset.process(dataset[index])
        loss_module.validate_target_window(len(tokens),offset,args.max_seq_length)
        if len(tokens)>args.max_seq_length or not tokenizer.decode(tokens[offset:]).lstrip().startswith('{"answer"'):
            raise ValueError('Recovery target/truncation mismatch')
frozen_parent=mx.load(str(parent_path));events=[];validation_events=[]
class Recorder:
    optimizer=None
    def on_val_loss_report(self,value):validation_events.append(value)
    def on_train_loss_report(self,value):
        step=int(self.optimizer.step.item())
        if step!=value['iteration'] or not 1<=step<=24:raise ValueError('Recovery update accounting mismatch')
        if value['peak_memory']>plan['memory_limit_gb']:raise RuntimeError('Memory ceiling')
        changed=dict(tree_flatten(model.trainable_parameters()))
        if set(changed)!=expected or not all(mx.all(mx.isfinite(v)).item() for v in changed.values()):
            raise ValueError('Trainable subset/nonfinite mismatch')
        full=subset_module.complete_adapter(frozen_parent,changed,expected)
        checkpoint=root/'durable-updates'/f'{step:03d}'
        checkpoint.mkdir()
        mx.save_safetensors(str(checkpoint/'adapters.safetensors'),full)
        state={key:mx.array(value) for key,value in tree_flatten(self.optimizer.state)}
        mx.save_safetensors(str(checkpoint/'optimizer.safetensors'),state)
        record={'event':'recovery_update_durable','segment_updates':step,'weight_lineage_updates':12+step,
            'total_confirmed_main_work':23+step,'adapter_sha256':digest(checkpoint/'adapters.safetensors'),
            'optimizer_sha256':digest(checkpoint/'optimizer.safetensors'),'optimizer_reset_at_lineage12':True,
            'loss':value['train_loss'],'peak_memory_gb':value['peak_memory']}
        write(checkpoint/'receipt.json',record);events.append(record)
        print(json.dumps(record),flush=True)
recorder=Recorder();pinned_train=lora.train
def verified_train(**kwargs):
    actual=dict(tree_flatten(model.trainable_parameters()))
    if set(actual)!=set(frozen_parent) or not all(mx.array_equal(actual[k],v).item() for k,v in frozen_parent.items()):
        raise ValueError('Recovery parent not loaded exactly')
    selected=subset_module.restrict_trainables(model,4)
    if set(selected)!=expected:raise ValueError('Recovery subset mismatch')
    kwargs['args'].clear_cache_threshold=args.clear_cache_threshold
    recorder.optimizer=kwargs['optimizer']
    return pinned_train(**kwargs,loss=loss_module.assistant_target_loss)
lora.train=verified_train
print(json.dumps({'event':'weight_only_recovery_start','updates':24,'parent_lineage':12,'optimizer_reset':True}),flush=True)
lora.train_model(args,model,train,valid,recorder)
if len(events)!=24:raise ValueError('Recovery incomplete')
write(root/'recovery-completion.json',{'status':'TRAINING_COMPLETE_EVALUATION_PENDING','events':events,
    'segment_updates':24,'total_confirmed_main_work':47,'weight_lineage_updates':36,
    'validation_events':validation_events,'formal_credit':False})
print(json.dumps({'event':'recovery_training_finished','segment_updates':24,'weight_lineage_updates':36}),flush=True)
