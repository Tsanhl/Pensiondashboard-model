"""Opt-in Qwen3 batch-one training memory path; no serving/weight changes.

Frozen prefix is evaluated outside AD, one layer at a time. Only a prefix with
no trainable tensors is permitted; its training-mode RNG draws are retained. The trainable tail
retains full-context gradients; query chunks attend to every causal key/value.
"""
from contextlib import contextmanager
import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_lm.models import qwen3
from mlx_lm.models.base import create_attention_mask
from assistant_target_loss import TARGET_WINDOW


def frozen_prefix(model, batch, last_layers, progress=None):
    if model.model_type != 'qwen3' or batch.shape[0] != 1:
        raise ValueError('Only Qwen3 batch one supported')
    if type(last_layers) is not int or not 0 < last_layers < len(model.layers):
        raise ValueError('Invalid frozen prefix boundary')
    boundary = len(model.layers)-last_layers
    allowed = tuple(f'model.layers.{i}.' for i in range(boundary,len(model.layers)))
    if any(not name.startswith(allowed) for name,_ in tree_flatten(model.trainable_parameters())):
        raise ValueError('Trainable parameter outside suffix')
    hidden=model.model.embed_tokens(batch[:,:-1]);mx.eval(hidden)
    mask=create_attention_mask(hidden)
    for i,layer in enumerate(model.layers[:boundary]):
        hidden=layer(hidden,mask,None);mx.eval(hidden);mx.clear_cache()
        if progress:progress(i+1,boundary)
    return hidden


def suffix_target_loss(model, hidden, batch, lengths, last_layers, window=TARGET_WINDOW):
    mask=create_attention_mask(hidden)
    for layer in model.layers[-last_layers:]:
        hidden=layer(hidden,mask,None)
    hidden=model.model.norm(hidden)
    start=max(0,batch.shape[1]-1-window)
    hidden=hidden[:,start:]
    logits=(model.model.embed_tokens.as_linear(hidden) if model.args.tie_word_embeddings
            else model.lm_head(hidden))
    positions=mx.arange(start+1,batch.shape[1])
    mask=(positions>=lengths[:,0:1]) & (positions<lengths[:,1:])
    tokens=mask.sum()
    value=(nn.losses.cross_entropy(logits,batch[:,start+1:])*mask).astype(mx.float32).sum()/tokens
    return value,tokens


def chunked_causal_attention(q,k,v,*,scale,chunk_size=128):
    if type(chunk_size) is not int or chunk_size<=0:
        raise ValueError('Invalid query chunk size')
    if q.ndim!=4 or k.ndim!=4 or v.ndim!=4 or q.shape[2]!=k.shape[2] or k.shape[2]!=v.shape[2]:
        raise ValueError('Full self-attention shape required')
    # Prefixing K/V makes SDPA's bottom-right causal diagonal match the original
    # absolute query positions. K/V are NOT detached; all their gradients sum.
    def block(qb,kb,vb):
        return mx.fast.scaled_dot_product_attention(qb,kb,vb,scale=scale,mask='causal')
    recompute=mx.checkpoint(block)
    return mx.concatenate([recompute(q[:,:,start:end],k[:,:,:end],v[:,:,:end])
        for start in range(0,q.shape[2],chunk_size)
        for end in [min(start+chunk_size,q.shape[2])]],axis=2)


@contextmanager
def query_chunked_qwen3(chunk_size=128):
    original=qwen3.scaled_dot_product_attention
    def bounded(q,k,v,cache,scale,mask,sinks=None):
        if cache is not None or sinks is not None or not isinstance(mask,str) or mask!='causal':
            raise ValueError('Chunked training requires uncached causal attention')
        return chunked_causal_attention(q,k,v,scale=scale,chunk_size=chunk_size)
    qwen3.scaled_dot_product_attention=bounded
    try:yield
    finally:qwen3.scaled_dot_product_attention=original
