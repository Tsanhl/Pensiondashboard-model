import importlib.util
import json
from pathlib import Path
import mlx.core as mx
mx.set_default_device(mx.cpu)
spec=importlib.util.spec_from_file_location('host_validation',Path(__file__).with_name('adaptability_validation.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Model:
    def eval(self):pass
rows=[(mx.array(1.25),mx.array(7)),(mx.array(0.75),mx.array(11)),(mx.array(2.5),mx.array(3))]
loss=lambda model,value,tokens:(value,tokens)
batches=lambda **kwargs:iter(rows)
actual=module.evaluate(Model(),rows,1,-1,loss=loss,iterate_batches=batches)
reference=(sum(v*n for v,n in rows)/sum(n for _,n in rows)).item()
assert abs(actual-reference)<1e-6
assert abs(actual-(1.25*7+.75*11+2.5*3)/21)<1e-12
print(json.dumps({'passed':True,'classification':'SYNTHETIC_CPU_VALIDATION_ONLY','reference':reference,'host_scalar':actual,'absolute_error':abs(actual-reference),'examples':3,'tokens':21}))
