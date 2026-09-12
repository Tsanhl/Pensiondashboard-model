"""Atomic, identity-bound batch-one checkpoints including sampler and RNG state.

This format cannot recover randomness that older checkpoints never recorded.
"""
import hashlib
import json
import os
from pathlib import Path
import random
import tempfile

import mlx.core as mx
import numpy as np

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()

def pack(value, arrays):
    if isinstance(value,mx.array):
        key=f't{len(arrays)}';arrays[key]=value
        return {'array':key}
    if isinstance(value,dict):return {'dict':[[key,pack(item,arrays)] for key,item in value.items()]}
    if isinstance(value,(list,tuple)):
        return {'tuple' if isinstance(value,tuple) else 'list':[pack(item,arrays) for item in value]}
    if value is None or isinstance(value,(str,int,float,bool)):return {'scalar':value}
    raise TypeError(f'Unsupported checkpoint value: {type(value)}')

def unpack(value,arrays):
    if len(value)!=1:raise ValueError('Invalid checkpoint tree')
    kind,item=next(iter(value.items()))
    if kind=='array':return arrays[item]
    if kind=='dict':return {key:unpack(child,arrays) for key,child in item}
    if kind=='list':return [unpack(child,arrays) for child in item]
    if kind=='tuple':return tuple(unpack(child,arrays) for child in item)
    if kind=='scalar':return item
    raise ValueError('Unknown checkpoint tree node')

def numpy_state(rng):
    kind,keys,pos,gauss,cached=rng.get_state()
    return [kind,keys.tolist(),pos,gauss,cached]

def restore_numpy(rng,state):
    kind,keys,pos,gauss,cached=state
    rng.set_state((kind,np.array(keys,dtype=np.uint32),pos,gauss,cached))

class BatchOneSampler:
    """Pinned padding semantics; private shuffle RNG isolates validation order."""
    def __init__(self,dataset,max_seq_length,seed=42,state=None):
        self.dataset=dataset;self.max_seq_length=max_seq_length
        self.rng=np.random.RandomState(seed)
        self.order=[];self.cursor=0;self.epoch=-1;self.presented=0
        self.sorted_indices=sorted(range(len(dataset)),key=lambda i:len(dataset[i][0]))
        if not self.sorted_indices:raise ValueError('Empty training dataset')
        for i in self.sorted_indices:
            tokens,offset=dataset[i]
            if not 0<offset<len(tokens)<=max_seq_length:raise ValueError('Invalid/truncated training item')
        if state is not None:
            if state['size']!=len(dataset) or state['max_seq_length']!=max_seq_length or state['sorted_indices']!=self.sorted_indices:
                raise ValueError('Sampler dataset/shape mismatch')
            order=state['order'];cursor=state['cursor']
            if sorted(order)!=list(range(len(dataset))) or not 0<=cursor<=len(order):raise ValueError('Invalid sampler cursor/order')
            if state['presented']!=state['epoch']*len(dataset)+cursor:raise ValueError('Sampler exposure mismatch')
            self.order=order;self.cursor=cursor;self.epoch=state['epoch'];self.presented=state['presented']
            restore_numpy(self.rng,state['rng'])

    def state(self):
        return {'size':len(self.dataset),'max_seq_length':self.max_seq_length,'sorted_indices':self.sorted_indices,
            'order':self.order.copy(),'cursor':self.cursor,'epoch':self.epoch,'presented':self.presented,'rng':numpy_state(self.rng)}

    def __next__(self):
        if self.cursor==len(self.order):
            self.order=self.rng.permutation(len(self.dataset)).tolist();self.cursor=0;self.epoch+=1
        index=self.sorted_indices[self.order[self.cursor]]
        tokens,offset=self.dataset[index];length=len(tokens)
        padded=min(self.max_seq_length,1+32*((length+31)//32))
        data=np.zeros((1,padded),np.int32);data[0,:length]=tokens
        self.cursor+=1;self.presented+=1
        return (mx.array(data),mx.array([[offset,length]])),index

def save_checkpoint(path,*,adapter,optimizer_state,sampler,identity,completed_updates):
    path=Path(path)
    if path.exists():raise FileExistsError(path)
    if completed_updates!=sampler.presented:raise ValueError('Save only at a completed batch-one update boundary')
    if int(optimizer_state['step'].item())!=completed_updates:raise ValueError('Optimizer/sampler step mismatch')
    mx.eval(adapter,optimizer_state,mx.random.state)
    if not adapter or not all(mx.all(mx.isfinite(v)).item() for v in adapter.values()):raise ValueError('Nonfinite/empty adapter')
    arrays={}
    tree=pack({'optimizer':optimizer_state,'mlx_rng':list(mx.random.state),'python_rng':random.getstate()},arrays)
    if not all(mx.all(mx.isfinite(v)).item() for v in arrays.values()):raise ValueError('Nonfinite optimizer/RNG')
    path.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.incomplete-',dir=path.parent))
    mx.save_safetensors(str(stage/'adapter.safetensors'),adapter)
    mx.save_safetensors(str(stage/'state.safetensors'),arrays)
    metadata={'version':'adaptability-resume-v1','identity':identity,'completed_updates':completed_updates,
        'tree':tree,'numpy_rng':numpy_state(np.random),'sampler':sampler.state(),
        'hashes':{name:digest(stage/name) for name in ('adapter.safetensors','state.safetensors')}}
    with (stage/'complete.json').open('x') as stream:
        json.dump(metadata,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
    for name in metadata['hashes']:
        with (stage/name).open('rb') as stream:os.fsync(stream.fileno())
    os.rename(stage,path)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)
    return metadata

def load_checkpoint(path,*,identity,dataset,max_seq_length):
    path=Path(path)
    if path.name.startswith('.incomplete-'):raise ValueError('Incomplete checkpoint')
    metadata=json.loads((path/'complete.json').read_text())
    if metadata['version']!='adaptability-resume-v1' or metadata['identity']!=identity:raise ValueError('Checkpoint identity mismatch')
    if set(metadata['hashes'])!={'adapter.safetensors','state.safetensors'}:raise ValueError('Checkpoint file set mismatch')
    for name,expected in metadata['hashes'].items():
        if digest(path/name)!=expected:raise ValueError('Checkpoint checksum mismatch')
    arrays=mx.load(str(path/'state.safetensors'));adapter=mx.load(str(path/'adapter.safetensors'))
    state=unpack(metadata['tree'],arrays)
    sampler=BatchOneSampler(dataset,max_seq_length,state=metadata['sampler'])
    if sampler.presented!=metadata['completed_updates'] or int(state['optimizer']['step'].item())!=sampler.presented:
        raise ValueError('Checkpoint update accounting mismatch')
    if not all(mx.all(mx.isfinite(v)).item() for v in [*adapter.values(),*arrays.values()]):raise ValueError('Nonfinite checkpoint')
    # The caller loads and shape-checks model/optimizer first, then restores RNG.
    return adapter,state,sampler,metadata

def restore_rng(state,metadata):
    if len(mx.random.state)!=len(state['mlx_rng']):raise ValueError('MLX RNG state shape mismatch')
    for current,saved in zip(mx.random.state,state['mlx_rng']):
        if current.shape!=saved.shape or current.dtype!=saved.dtype:raise ValueError('MLX RNG key mismatch')
        current[...]=saved
    random.setstate(state['python_rng'])
    restore_numpy(np.random,metadata['numpy_rng'])
