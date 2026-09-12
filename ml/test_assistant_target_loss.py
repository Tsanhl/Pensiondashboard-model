"""Synthetic CPU gradient-equivalence checks; no real/private evaluation data."""
import importlib.util
import json
import sys
from pathlib import Path
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm.models.qwen3 import Model, ModelArgs
from mlx_lm.tuner.trainer import default_loss

spec=importlib.util.spec_from_file_location('target_loss',Path(__file__).with_name('assistant_target_loss.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
mx.set_default_device(mx.cpu)
mx.random.seed(42)


def reference(model,batch,lengths):
    logits=model(batch[:,:-1]);positions=mx.arange(1,batch.shape[1])
    mask=(positions>=lengths[:,0:1]) & (positions<lengths[:,1:])
    n=mask.sum()
    return (nn.losses.cross_entropy(logits,batch[:,1:])*mask).astype(mx.float32).sum()/n,n


results=[]
for tied in [True,False]:
    print(json.dumps({'event':'synthetic_case_start','tied':tied}),flush=True)
    model=Model(ModelArgs(model_type='qwen3',hidden_size=16,num_hidden_layers=2,intermediate_size=32,
                         num_attention_heads=2,num_key_value_heads=1,head_dim=8,rms_norm_eps=1e-6,
                         vocab_size=48,max_position_embeddings=256,rope_theta=10000.,tie_word_embeddings=tied))
    model.eval()
    batch=mx.array([[i%47 for i in range(17)]+[0]*4]);lengths=mx.array([[13,17]])
    full,full_grad=nn.value_and_grad(model,reference)(model,batch,lengths)
    narrow,narrow_grad=nn.value_and_grad(model,lambda m,b,l:module.assistant_target_loss(m,b,l,window=8))(model,batch,lengths)
    mx.eval(full,full_grad,narrow,narrow_grad)
    assert full[1].item()==narrow[1].item()==4
    assert mx.allclose(full[0],narrow[0],atol=1e-6,rtol=1e-5).item()
    fg=dict(tree_flatten(full_grad));ng=dict(tree_flatten(narrow_grad));assert fg.keys()==ng.keys()
    max_error=max(mx.max(mx.abs(fg[k]-ng[k])).item() for k in fg)
    assert all(mx.allclose(fg[k],ng[k],atol=2e-6,rtol=2e-5).item() for k in fg)
    _,old_count=default_loss(model,batch,lengths)
    assert old_count.item()==5 # Reproduce pinned padding-mask defect separately.
    compiled=mx.compile(lambda b,l:module.assistant_target_loss(model,b,l,window=8))
    compiled_value=compiled(batch,lengths);mx.eval(compiled_value)
    assert mx.allclose(full[0],compiled_value[0],atol=1e-6,rtol=1e-5).item()
    print(json.dumps({'event':'loss_gradient_and_compiled_forward_pass','tied':tied}),flush=True)
    reference_model=Model(model.args)
    reference_model.load_weights(tree_flatten(model.parameters()))
    left=optim.Adam(learning_rate=1e-5);right=optim.Adam(learning_rate=1e-5)
    state=[model.state,left.state,mx.random.state]
    def train_step(b,l):
        value,gradient=nn.value_and_grad(model,lambda m,x,y:module.assistant_target_loss(m,x,y,window=8))(model,b,l)
        left.update(model,gradient)
        return value
    compiled_step=mx.compile(train_step,inputs=state,outputs=state)
    for step in (range(1,3) if '--compiled-optimizer' in sys.argv else []):
        print(json.dumps({'event':'compiled_optimizer_start','tied':tied,'step':step}),flush=True)
        value=compiled_step(batch,lengths);mx.eval(state,value)
        ref_value,gradient=nn.value_and_grad(reference_model,reference)(reference_model,batch,lengths)
        right.update(reference_model,gradient);mx.eval(reference_model.state,right.state)
        assert left.step.item()==right.step.item()==step
        actual=dict(tree_flatten(model.parameters()));expected=dict(tree_flatten(reference_model.parameters()))
        assert all(mx.allclose(actual[k],expected[k],atol=2e-6,rtol=2e-5).item() for k in actual)
    results.append({'tied_head':tied,'correct_target_count':4,'pinned_default_target_count':5,
                    'loss_difference':abs(full[0].item()-narrow[0].item()),'max_gradient_error':max_error,'compiled_equal':True,'synthetic_compiled_adam_updates_equal':2 if '--compiled-optimizer' in sys.argv else 'NOT_RUN'})
for total,offset in [(3292,3218),(2203,2140)]:module.validate_target_window(total,offset,3584)
try:module.validate_target_window(3292,3000,3584)
except ValueError:pass
else:raise AssertionError('Omitted targets were not rejected')
print(json.dumps({'classification':'SYNTHETIC_CPU_ONLY','passed':True,'results':results,'omitted_target_rejected':True},indent=2))
