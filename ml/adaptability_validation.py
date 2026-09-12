"""Full token-weighted validation, detaching each batch before accumulation."""
import json
import math
import time

def evaluate(model,dataset,batch_size,num_batches,max_seq_length=2048,loss=None,iterate_batches=None,clear_cache_threshold=0):
    import mlx.core as mx
    from mlx_lm.tuner.trainer import iterate_batches as default_batches
    if batch_size!=1: raise ValueError('Only proven batch-one validation supported')
    if loss is None: raise ValueError('Explicit proven loss function required')
    batches=iterate_batches or default_batches
    model.eval()
    weighted=0.0;total_tokens=0;count=0
    for batch in batches(dataset=dataset,batch_size=batch_size,max_seq_length=max_seq_length):
        if num_batches!=-1 and count>=num_batches:break
        start=time.monotonic()
        value,tokens=loss(model,*batch)
        mx.eval(value,tokens)
        scalar=float(value.item());n=int(tokens.item())
        if not math.isfinite(scalar) or n<=0:raise ValueError('Invalid validation batch')
        weighted+=scalar*n;total_tokens+=n;count+=1
        del value,tokens,batch
        if mx.get_cache_memory()>clear_cache_threshold:mx.clear_cache()
        print(json.dumps({'event':'validation_example_completed','index':count,'loss':scalar,'target_tokens':n,'seconds':time.monotonic()-start}),flush=True)
    if not count or (num_batches==-1 and count!=len(dataset)):raise ValueError('Full validation coverage missing')
    return weighted/total_tokens
