"""Disposable, stage-measured MLX diagnostic. Never a main training resume."""
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import os


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    binding_path = Path(sys.argv[1]).resolve(strict=True)
    binding = json.loads(binding_path.read_text())
    plan = json.loads(Path(binding['original_plan']).read_text())
    for record in binding['bound_inputs']:
        if digest(record['path']) != record['sha256']:
            raise ValueError('Diagnostic input changed: ' + Path(record['path']).name)
    if binding['mode'] not in ('eager', 'compiled') or binding['updates'] != 2:
        raise ValueError('Only two disposable diagnostic updates allowed')
    for name, version in binding['versions'].items():
        if importlib.metadata.version(name) != version:
            raise ValueError('Pinned dependency mismatch: ' + name)
    output = Path(binding['output'])
    clean_reload = len(sys.argv) > 2 and sys.argv[2] == '--clean-reload'
    if not clean_reload:
        output.mkdir(mode=0o700, exist_ok=False)
    import mlx.core as mx
    import mlx.nn as nn
    import numpy as np
    from mlx.utils import tree_flatten
    import mlx_lm.lora as lora
    from mlx_lm import load
    from mlx_lm.tuner.datasets import load_dataset
    from mlx_lm.tuner.trainer import default_loss, grad_checkpoint, iterate_batches
    subset_spec=importlib.util.spec_from_file_location('adaptability_trainables',Path(__file__).with_name('adaptability_trainables.py'))
    subset_module=importlib.util.module_from_spec(subset_spec)
    subset_spec.loader.exec_module(subset_module)
    validate_window = None
    if binding.get('loss_implementation') == 'assistant_target_loss_v1':
        spec = importlib.util.spec_from_file_location('target_loss', Path(__file__).with_name('assistant_target_loss.py'))
        loss_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loss_module)
        default_loss = loss_module.assistant_target_loss
        validate_window = loss_module.validate_target_window
    clock = time.perf_counter()
    events = []

    def event(name, **kw):
        value = dict(event=name, elapsed_seconds=time.perf_counter()-clock,
                     active_gb=mx.get_active_memory()/1e9,
                     peak_gb=mx.get_peak_memory()/1e9, **kw)
        events.append(value)
        print(json.dumps(value), flush=True)

    def stage(name, fn):
        event('stage_start', stage=name)
        start = time.perf_counter()
        value = fn()
        event('stage_completed', stage=name, seconds=time.perf_counter()-start)
        if mx.get_peak_memory()/1e9 > plan['memory_limit_gb']:
            raise RuntimeError('Peak memory ceiling exceeded')
        return value

    mx.set_cache_limit(256*1024*1024)
    if mx.metal.is_available():
        # The pinned trainer makes this same per-process call; no sysctl changes.
        mx.set_wired_limit(mx.device_info()['max_recommended_working_set_size'])
    event('diagnostic_identity', mode=binding['mode'], binding_sha256=digest(binding_path),
          parent_sha256=digest(plan['parent_adapter']),
          device=mx.device_info(), main_updates=0)
    stage('device_kernel', lambda: mx.eval(mx.sum(mx.ones((256,256)) @ mx.ones((256,256)))))
    model, tokenizer = stage('loading', lambda: load(plan['base_path'], adapter_path=str(output) if clean_reload else None, tokenizer_config={'trust_remote_code':False}))
    class ServingTokenizer:
        def __getattr__(self, name): return getattr(tokenizer, name)
        def apply_chat_template(self, messages, **kwargs):
            kwargs['enable_thinking'] = False
            return tokenizer.apply_chat_template(messages, **kwargs)
    config = dict(lora.CONFIG_DEFAULTS)
    config.update(plan['hyperparameters'])
    config.update(data=plan['smoke']['data'], adapter_path=str(output), iters=2,
                  model=plan['base_path'], resume_adapter_file=plan['parent_adapter'],
                  mask_prompt=True, train=True, test=False)
    args = types.SimpleNamespace(**config)
    train, valid, _ = load_dataset(args, ServingTokenizer())
    for dataset in (train, valid):
        for index in range(len(dataset)):
            tokens, offset = dataset.process(dataset[index])
            if not 0 < offset < len(tokens) <= args.max_seq_length:
                raise ValueError('Truncation or invalid target mask')
            if validate_window:
                validate_window(len(tokens), offset, args.max_seq_length)
            if not tokenizer.decode(tokens[offset:]).lstrip().startswith('{"answer"'):
                raise ValueError('Wrong target prefix')
            event('tokenized_example', tokens=len(tokens), target_tokens=len(tokens)-offset)
    np.random.seed(args.seed)

    if clean_reload:
        from mlx_lm.tuner.datasets import CacheDataset
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler
        receipt = json.loads((output/'receipt.json').read_text())
        actual = dict(tree_flatten(model.trainable_parameters()))
        # Inference load may freeze adapters: compare saved keys against all parameters.
        actual = dict(tree_flatten(model.parameters()))
        saved = mx.load(str(output/'adapters.safetensors'))
        if not all(k in actual and mx.array_equal(v, actual[k]).item() for k,v in saved.items()):
            raise ValueError('Clean interpreter adapter identity mismatch')
        model.eval()
        values = []
        for index,batch in enumerate(iterate_batches(CacheDataset(valid),1,args.max_seq_length)):
            def validate():
                loss,tokens = default_loss(model,*batch)
                mx.eval(loss,tokens)
                if not mx.isfinite(loss).item(): raise ValueError('Nonfinite clean validation')
                return {'loss':float(loss.item()),'tokens':int(tokens.item())}
            values.append(stage('validation',validate))
            event('clean_validation_example',index=index,**values[-1])
            mx.clear_cache()
        messages=json.loads((Path(plan['dataset'])/'valid.jsonl').read_text().splitlines()[0])['messages']
        prompt=tokenizer.apply_chat_template(messages[:-1],tokenize=False,add_generation_prompt=True,enable_thinking=False)
        answer=stage('generation',lambda:generate(model,tokenizer,prompt=prompt,max_tokens=192,sampler=make_sampler(temp=0),verbose=False))
        if not answer.strip(): raise ValueError('Empty clean generation')
        (output/'clean-generation.json').write_text(json.dumps({'prompt_sha256':hashlib.sha256(prompt.encode()).hexdigest(),'answer':answer,'semantic_acceptance':'NOT_ASSESSED'}))
        receipt.update(clean_interpreter_reload=True,clean_validation=values,clean_generation_sha256=digest(output/'clean-generation.json'))
        receipt['events'] += events
        receipt['events'].append({'event':'clean_reload_completed','validation_examples':len(values),'fresh_interpreter':True})
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2))
        event('clean_reload_completed',validation_examples=len(values),fresh_interpreter=True)
        return

    def diagnostic_train(model, optimizer, train_dataset, val_dataset, args, **unused):
        parent = mx.load(plan['parent_adapter'])
        actual = dict(tree_flatten(model.trainable_parameters()))
        if set(parent) != set(actual):
            raise ValueError('Parent adapter/trainable key mismatch')
        def compare_parent():
            if not all(v.shape == actual[k].shape and mx.array_equal(v,actual[k]).item() for k,v in parent.items()):
                raise ValueError('Parent adapter was not loaded exactly')
        stage('parent_verification', compare_parent)
        parent_keys=set(parent)
        del parent, actual
        subset_module.restrict_trainables(model,plan['hyperparameters'].get('trainable_last_layers',16))
        trainable_keys=set(dict(tree_flatten(model.trainable_parameters())))
        def frozen_digest():
            h=hashlib.sha256()
            for key,value in tree_flatten(model.parameters()):
                if key not in trainable_keys:
                    h.update(key.encode())
                    h.update(np.array(value.view(mx.uint8)).tobytes())
            return h.hexdigest()
        frozen_before=stage('frozen_verification',frozen_digest)
        event('trainable_parameters', count=sum(v.size for _,v in tree_flatten(model.trainable_parameters())),
              gradient_checkpoint=args.grad_checkpoint, cache_clear_threshold_effective=args.clear_cache_threshold)
        if args.grad_checkpoint:
            grad_checkpoint(model.layers[0])
        def loss_sync(batch):
            loss, tokens = default_loss(model, *batch)
            mx.eval(loss, tokens)
            return float(loss.item()), int(tokens.item())
        model.eval()
        validation_count=0
        for validation_batch in iterate_batches(val_dataset,1,args.max_seq_length):
            val=stage('validation',lambda:loss_sync(validation_batch))
            if not np.isfinite(val[0]): raise ValueError('Nonfinite validation loss')
            event('initial_validation',loss=val[0],tokens=val[1],completed_updates=0)
            validation_count+=1
            mx.clear_cache()
        del validation_batch
        if validation_count != 8: raise ValueError('Full validation eight required')
        mx.clear_cache()
        model.train()
        batches = iterate_batches(train_dataset, 1, args.max_seq_length, loop=True)
        value_grad = nn.value_and_grad(model, default_loss)
        state = [model.state, optimizer.state, mx.random.state]
        compile_traces = 0
        def update_step(batch):
            nonlocal compile_traces
            compile_traces += 1
            event('compiled_trace_enter', trace_count=compile_traces)
            (loss, tokens), gradients = value_grad(model, *batch)
            finite=mx.all(mx.stack([mx.all(mx.isfinite(v)) for _,v in tree_flatten(gradients)]))
            optimizer.update(model, gradients)
            return loss, tokens, finite
        compiled = mx.compile(update_step, inputs=state, outputs=state) if binding['mode']=='compiled' else None
        for index in range(1,3):
            batch = next(batches)
            event('update_start', update=index, padded_shape=list(batch[0].shape))
            if compiled is None:
                if index == 1:
                    rng = [mx.array(x) for x in mx.random.state]
                    stage('forward', lambda: loss_sync(batch))
                    mx.random.state = rng
                    mx.clear_cache()
                value, gradients = stage('gradient_graph', lambda: value_grad(model, *batch))
                stage('gradient', lambda: mx.eval(value, gradients))
                stage('optimizer_graph', lambda: optimizer.update(model, gradients))
                stage('optimizer', lambda: mx.eval(state))
                loss, tokens = value
                finite=mx.all(mx.stack([mx.all(mx.isfinite(v)) for _,v in tree_flatten(gradients)]))
                mx.eval(finite)
                del gradients, value
            else:
                loss, tokens, finite = stage('compilation_graph', lambda: compiled(batch))
                stage('compiled_update', lambda: mx.eval(state, loss, tokens, finite))
            if not finite.item() or not mx.isfinite(loss).item():
                raise ValueError('Nonfinite gradient or loss')
            if int(optimizer.step.item()) != index:
                raise ValueError('Optimiser update count mismatch')
            event('update_completed', update=index, optimizer_step=int(optimizer.step.item()),
                  loss=float(loss.item()), target_tokens=int(tokens.item()), finite_gradients=True, main_run_credit=False)
            del loss, tokens, batch
            mx.clear_cache()
        adapter = output/'adapters.safetensors'
        stage('save', lambda: mx.save_safetensors(str(adapter), {k:v for k,v in tree_flatten(model.parameters()) if k in parent_keys}))
        saved = mx.load(str(adapter))
        parent=mx.load(plan['parent_adapter'])
        changed=sum(not mx.array_equal(v,parent[k]).item() for k,v in saved.items())
        if not changed or not all(mx.all(mx.isfinite(v)).item() for v in saved.values()):
            raise ValueError('No finite adapter parameter change')
        frozen_after=stage('frozen_verification',frozen_digest)
        if frozen_before!=frozen_after: raise ValueError('Frozen base changed')
        def reload_check():
            model.load_weights(str(adapter), strict=False)
            mx.eval(model.trainable_parameters())
            current = {k:v for k,v in tree_flatten(model.parameters()) if k in parent_keys}
            if set(current) != set(saved) or not all(mx.array_equal(v,current[k]).item() for k,v in saved.items()):
                raise ValueError('Saved adapter reload mismatch')
        stage('reload', reload_check)
        event('diagnostic_completed', updates=2, main_updates=0,
              saved_sha256=digest(adapter), save_reload_verified=True, compile_traces=compile_traces)
        with (output/'receipt.json').open('x') as stream:
            json.dump(dict(binding_sha256=digest(binding_path),events=events,updates=2,
                           main_updates=0,adapter_sha256=digest(adapter),save_reload_verified=True,
                           changed_adapter_tensors=changed,frozen_before_sha256=frozen_before,
                           frozen_after_sha256=frozen_after,initial_validation_examples=validation_count),stream,indent=2)

    # Reuse pinned preparation, conversion, parent loading and optimiser setup.
    # Replace only its training loop in this disposable process, never the library.
    lora.train = diagnostic_train
    lora.train_model(args, model, train, valid)
    event('stage_start',stage='loading')
    # exec replaces the entire interpreter/address space: no training model/cache survives.
    os.execv(sys.executable,[sys.executable,'-I','-B',str(Path(__file__).resolve()),str(binding_path),'--clean-reload'])


if __name__ == '__main__':
    main()
