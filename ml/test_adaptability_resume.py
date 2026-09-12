"""CPU-only fresh-process equivalence and corrupt-checkpoint rejection."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from functools import partial
sys.path.insert(0,str(Path(__file__).parent))
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
import numpy as np
import random
from mlx.utils import tree_flatten
from adaptability_resume import BatchOneSampler,load_checkpoint,save_checkpoint,restore_rng
mx.set_default_device(mx.cpu)
DATA=[([1,2,3+i,4,5,6][:4+i%3],2) for i in range(5)]
IDENTITY={'dataset':'synthetic-five-v1','loss':'toy-dropout-mse','seed':91}

class Toy(nn.Module):
    def __init__(self):
        super().__init__();self.linear=nn.Linear(2,2);self.dropout=nn.Dropout(0.25)
    def __call__(self,x):return self.linear(self.dropout(x))

def worker(mode,root):
    mx.random.seed(91);np.random.seed(91);random.seed(91)
    model=Toy();optimizer=optim.Adam(1e-3);sampler=BatchOneSampler(DATA,128,seed=91)
    start=0;order=[]
    if mode=='resume':
        adapter,state,sampler,metadata=load_checkpoint(root/'split-5',identity=IDENTITY,dataset=DATA,max_seq_length=128)
        model.load_weights(list(adapter.items()),strict=True);optimizer.state=state['optimizer'];restore_rng(state,metadata)
        start=5
    model.train()
    state=[model.state,optimizer.state,mx.random.state]
    def loss(model,x):return mx.mean(model(x)**2)
    vg=nn.value_and_grad(model,loss)
    @partial(mx.compile,inputs=state,outputs=state)
    def step(x):
        value,gradient=vg(model,x);optimizer.update(model,gradient);return value
    end=5 if mode=='split' else 12
    for n in range(start,end):
        batch,index=next(sampler);order.append(index)
        # Exercise all three RNGs, including validation-like NumPy consumption.
        x=mx.array([[float(index+random.random()),float(np.random.random())]])
        value=step(x);mx.eval(state,value)
        assert int(optimizer.step.item())==n+1
    path=root/('split-5' if mode=='split' else mode+'-12')
    save_checkpoint(path,adapter=dict(tree_flatten(model.parameters())),optimizer_state=optimizer.state,
        sampler=sampler,identity=IDENTITY,completed_updates=end)
    print(json.dumps({'mode':mode,'order':order,'completed_updates':end}))

if len(sys.argv)>1:
    worker(sys.argv[1],Path(sys.argv[2]));sys.exit(0)
with tempfile.TemporaryDirectory(prefix='adaptability-resume-test-') as temp:
    root=Path(temp);runs=[]
    for mode in ('continuous','split','resume'):
        result=subprocess.run([sys.executable,'-I','-B',__file__,mode,temp],capture_output=True,text=True)
        assert result.returncode == 0, result.stderr
        runs.append(json.loads(result.stdout))
    assert runs[0]['order']==runs[1]['order']+runs[2]['order']
    for name in ('adapter.safetensors','state.safetensors'):
        a=mx.load(str(root/'continuous-12'/name));b=mx.load(str(root/'resume-12'/name))
        assert set(a)==set(b)
        assert all(mx.array_equal(a[key],b[key]).item() for key in a),name
    a=json.loads((root/'continuous-12/complete.json').read_text());b=json.loads((root/'resume-12/complete.json').read_text())
    assert a['sampler']==b['sampler'] and a['numpy_rng']==b['numpy_rng'] and a['tree']==b['tree']
    try:load_checkpoint(root/'resume-12',identity={'wrong':True},dataset=DATA,max_seq_length=128)
    except ValueError:pass
    else:raise AssertionError('Wrong identity accepted')
    sampler=BatchOneSampler(DATA,128);next(sampler);bad=sampler.state();bad['cursor']=4
    try:BatchOneSampler(DATA,128,state=bad)
    except ValueError:pass
    else:raise AssertionError('Corrupt sampler accepted')
    with (root/'resume-12/state.safetensors').open('ab') as stream:stream.write(b'corruption')
    try:load_checkpoint(root/'resume-12',identity=IDENTITY,dataset=DATA,max_seq_length=128)
    except ValueError:pass
    else:raise AssertionError('Corrupt checkpoint accepted')
    print(json.dumps({'passed':True,'device':'CPU','continuous_updates':12,'split_updates':[5,7],
        'fresh_process_resume':True,'sample_order_exact':True,'model_optimizer_rng_bit_exact':True,
        'wrong_identity_and_corruption_rejected':True,'full_model_proof':False}))
