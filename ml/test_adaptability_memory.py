"""Synthetic CPU correctness only, no model/data loading or GPU workload."""
import json
from functools import partial
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).parent))
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm.models.qwen3 import Model,ModelArgs
from mlx_lm.tuner.lora import LoRALinear
from mlx_lm.tuner.trainer import grad_checkpoint
from assistant_target_loss import assistant_target_loss
from adaptability_memory import frozen_prefix,suffix_target_loss,chunked_causal_attention,query_chunked_qwen3
mx.set_default_device(mx.cpu);mx.random.seed(17)
def close(a,b):
    assert mx.allclose(a,b,atol=2e-5,rtol=2e-4).item(),float(mx.max(mx.abs(a-b)).item())
for length in [17,32,37]:
    q=mx.random.normal((1,4,length,8));k=mx.random.normal((1,2,length,8));v=mx.random.normal((1,2,length,8))
    weight=mx.random.normal(q.shape)
    ref=lambda q,k,v:mx.fast.scaled_dot_product_attention(q,k,v,scale=8**-.5,mask='causal')
    alt=lambda q,k,v:chunked_causal_attention(q,k,v,scale=8**-.5,chunk_size=8)
    close(ref(q,k,v),alt(q,k,v))
    gr=mx.grad(lambda q,k,v:mx.sum(ref(q,k,v)*weight),argnums=(0,1,2))(q,k,v)
    ga=mx.grad(lambda q,k,v:mx.sum(alt(q,k,v)*weight),argnums=(0,1,2))(q,k,v)
    for a,b in zip(gr,ga):close(a,b)
args=ModelArgs(model_type='qwen3',hidden_size=16,num_hidden_layers=4,intermediate_size=32,
    num_attention_heads=4,rms_norm_eps=1e-6,vocab_size=64,num_key_value_heads=2,
    max_position_embeddings=128,rope_theta=10000,head_dim=4,tie_word_embeddings=False)
def make():
    m=Model(args)
    for layer in m.layers:
        layer.self_attn.q_proj=LoRALinear.from_base(layer.self_attn.q_proj,r=2,scale=1,dropout=0.05)
        layer.self_attn.q_proj.lora_b=mx.random.normal((2,16))*0.01
    m.freeze()
    for layer in m.layers[-2:]:layer.self_attn.q_proj.unfreeze(keys=['lora_a','lora_b'],recurse=False)
    m.train();return m
a=make();b=make();b.load_weights(tree_flatten(a.parameters()))
grad_checkpoint(a.layers[0])
oa=optim.Adam(1e-5);ob=optim.Adam(1e-5)
for total,offset in [(37,29),(32,23)]:
    batch=mx.random.randint(0,64,(1,total));lengths=mx.array([[offset,total]])
    mx.random.seed(112+total)
    (lr,tr),gr=nn.value_and_grad(a,assistant_target_loss)(a,batch,lengths)
    mx.eval(lr,tr,gr,mx.random.state)
    ref_rng=[mx.array(x) for x in mx.random.state]
    mx.random.seed(112+total)
    h=frozen_prefix(b,batch,2)
    with query_chunked_qwen3(8):
        fn=lambda m,h,x,l:suffix_target_loss(m,h,x,l,2)
        state=[b.state,mx.random.state]
        @partial(mx.compile,inputs=state,outputs=state)
        def gradients(h,x,l):return nn.value_and_grad(b,fn)(b,h,x,l)
        (la,ta),ga=gradients(h,batch,lengths)
        mx.eval(la,ta,ga)
    assert all(mx.array_equal(x,y).item() for x,y in zip(ref_rng,mx.random.state))
    close(lr,la);assert tr.item()==ta.item()
    for (ka,va),(kb,vb) in zip(tree_flatten(gr),tree_flatten(ga)):
        assert ka==kb;close(va,vb)
    oa.update(a,gr);ob.update(b,ga);mx.eval(a.state,b.state,oa.state,ob.state)
    for (_,va),(_,vb) in zip(tree_flatten(a.parameters()),tree_flatten(b.parameters())):close(va,vb)
b.model.embed_tokens.unfreeze()
try:frozen_prefix(b,batch,2)
except ValueError:pass
else:raise AssertionError('Trainable prefix accepted')
print(json.dumps({'passed':True,'device':'CPU','full_model_proof':False,'attention_shapes':3,
 'qkv_gradient_equivalence':True,'suffix_loss_gradient_equivalence':True,'adam_updates':2,
 'trainable_prefix_rejected':True,'rtol':2e-4,'atol':2e-5}))
