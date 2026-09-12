"""No-model synthetic coverage for frozen adapters and complete save reconstruction."""
import importlib.util
from pathlib import Path
import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim
from mlx.utils import tree_flatten
from mlx_lm.tuner.lora import LoRALinear
spec=importlib.util.spec_from_file_location('subset',Path(__file__).with_name('adaptability_trainables.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
mx.set_default_device(mx.cpu)
class Tiny(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers=[LoRALinear(4,4,r=2) for _ in range(4)]
        for layer in self.layers: layer.linear.freeze()
    def __call__(self,x):
        for layer in self.layers: x=layer(x)
        return x
model=Tiny(); parent=dict(tree_flatten(model.trainable_parameters()))
mx.eval(parent)
selected=module.restrict_trainables(model,1)
assert len(selected)==2 and len(parent)==8
optimizer=optim.Adam(1e-5)
for _ in range(2):
    value,gradient=nn.value_and_grad(model,lambda m:mx.sum(m(mx.ones((2,4)))**2))(model)
    optimizer.update(model,gradient);mx.eval(model.state,optimizer.state)
changed=dict(tree_flatten(model.trainable_parameters()))
complete=module.complete_adapter(parent,changed,selected)
actual=dict(tree_flatten(model.parameters()))
assert set(complete)==set(parent)
assert all(mx.array_equal(complete[k],actual[k]).item() for k in complete)
assert all(mx.array_equal(parent[k],complete[k]).item() for k in parent if k not in selected)
assert any(not mx.array_equal(parent[k],complete[k]).item() for k in selected)
try: module.complete_adapter(parent,{},selected)
except ValueError: pass
else: raise AssertionError('Incomplete checkpoint accepted')
print('PASS: two actual synthetic updates, frozen earlier adapters, complete checkpoint reconstruction, missing-subset rejection')
