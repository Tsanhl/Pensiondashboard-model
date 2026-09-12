"""One bounded synthetic attention gradient; no model or dataset files."""
from pathlib import Path
import sys,time,json
sys.path.insert(0,str(Path(__file__).parent))
import mlx.core as mx
from adaptability_memory import chunked_causal_attention
mode=sys.argv[1]
if mode not in ('reference','chunked'):raise ValueError('Explicit benchmark mode required')
if not mx.metal.is_available():raise ValueError('Metal required')
mx.random.seed(42);mx.set_cache_limit(0)
q=mx.random.normal((1,8,512,64));k=mx.random.normal((1,2,512,64));v=mx.random.normal((1,2,512,64))
mx.eval(q,k,v);mx.clear_cache();mx.reset_peak_memory()
start=time.monotonic()
fn=(lambda q,k,v:chunked_causal_attention(q,k,v,scale=0.125,chunk_size=64)) if mode=='chunked' else (lambda q,k,v:mx.fast.scaled_dot_product_attention(q,k,v,scale=0.125,mask='causal'))
value,grad=mx.value_and_grad(lambda q,k,v:mx.sum(fn(q,k,v)**2),argnums=(0,1,2))(q,k,v)
mx.eval(value,grad)
if not all(mx.all(mx.isfinite(x)).item() for x in grad):raise ValueError('Nonfinite gradients')
print(json.dumps({'mode':mode,'device':'Metal','sequence':512,'query_heads':8,'kv_heads':2,'head_dim':64,
 'peak_bytes':mx.get_peak_memory(),'seconds':time.monotonic()-start,'value':value.item(),'full_model_proof':False}))
