"""Versioned local behavior training; no protected-bank imports or hosted model."""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import types


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class ServingTokenizer:
    """Use exactly the serving non-thinking prefix and mask all prompt tokens."""
    def __init__(self, wrapped):
        self.wrapped = wrapped

    def __getattr__(self, name):
        return getattr(self.wrapped, name)

    def apply_chat_template(self, messages, **kwargs):
        kwargs['enable_thinking'] = False
        return self.wrapped.apply_chat_template(messages, **kwargs)


def main():
    plan_path = Path(sys.argv[1]).resolve(strict=True)
    plan = json.loads(plan_path.read_text())
    mode = sys.argv[2]
    if mode not in ('smoke', 'train'):
        raise ValueError('Explicit smoke or train mode required')
    if plan.get('execution') != {'mode':'compiled','loss_implementation':'assistant_target_loss_v1'}:
        raise ValueError('Explicit corrected-loss execution binding required; legacy stalled plans are not runnable')
    if plan['authorization']['owner_authorized_training'] is not True:
        raise ValueError('Owner training authorization missing')
    if importlib.metadata.version('mlx-lm') != '0.31.3':
        raise ValueError('Pinned mlx-lm 0.31.3 required')
    for record in plan['bound_inputs']:
        if digest(record['path']) != record['sha256']:
            raise ValueError('Bound training input changed: ' + Path(record['path']).name)
    output = Path(plan[mode]['adapter_path'])
    if output.exists():
        raise ValueError('Refusing existing adapter output')
    import mlx.core as mx
    import numpy as np
    from mlx_lm import load
    import mlx_lm.lora as lora
    from mlx_lm.lora import CONFIG_DEFAULTS
    from mlx.utils import tree_flatten
    from mlx_lm.tuner.datasets import load_dataset
    from mlx_lm.tuner.trainer import evaluate, CacheDataset
    spec = importlib.util.spec_from_file_location('target_loss', Path(__file__).with_name('assistant_target_loss.py'))
    loss_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loss_module)
    subset_spec=importlib.util.spec_from_file_location('adaptability_trainables',Path(__file__).with_name('adaptability_trainables.py'))
    subset_module=importlib.util.module_from_spec(subset_spec)
    subset_spec.loader.exec_module(subset_module)
    mx.set_cache_limit(256 * 1024 * 1024)
    np.random.seed(plan['hyperparameters']['seed'])
    model, tokenizer = load(plan['base_path'], tokenizer_config={'trust_remote_code': False})
    tokenizer = ServingTokenizer(tokenizer)
    config = dict(CONFIG_DEFAULTS)
    config.update(plan['hyperparameters'])
    config.update(plan[mode])
    config.update(model=plan['base_path'], resume_adapter_file=plan['parent_adapter'], mask_prompt=True, train=True, test=False)
    args = types.SimpleNamespace(**config)
    train, valid, _ = load_dataset(args, tokenizer)
    for dataset in (train, valid):
        for index in range(len(dataset)):
            tokens, offset = dataset.process(dataset[index])
            if offset < 1 or len(tokens) <= offset or len(tokens) > args.max_seq_length:
                raise ValueError('Truncated or invalid loss mask')
            loss_module.validate_target_window(len(tokens), offset, args.max_seq_length)
            target = tokenizer.decode(tokens[offset:])
            if not target.lstrip().startswith('{"answer"') or '<think>' in target:
                raise ValueError('Target does not match serving JSON completion')
    print(json.dumps({'event':'verified_training_start','mode':mode,'train':len(train),'valid':len(valid),'parent_sha256':digest(plan['parent_adapter']),'plan_sha256':digest(plan_path),'serving_prefix_matched':True}),flush=True)
    validation_events = []
    update_events = []
    class Recorder:
        optimizer = None
        def on_val_loss_report(self, value):
            validation_events.append(value)
        def on_train_loss_report(self, value):
            if value['peak_memory'] > plan['memory_limit_gb']:
                raise RuntimeError('Training exceeded the measured memory ceiling')
            if self.optimizer is None:
                raise RuntimeError('Optimiser accounting was not attached')
            actual = int(self.optimizer.step.item())
            expected = value['iteration'] // args.grad_accumulation_steps
            if actual != expected:
                raise RuntimeError(f'Optimiser update count mismatch: actual {actual}, expected {expected}')
            record = {'event':'optimizer_update_accounted','microbatch_iteration':value['iteration'],
                      'completed_optimizer_updates':actual,
                      'presented_examples':value['iteration'] * args.batch_size}
            update_events.append(record)
            print(json.dumps(record), flush=True)
    recorder = Recorder()
    pinned_train = lora.train
    trained_keys = set()
    def verified_train(**kwargs):
        nonlocal trained_keys
        # Pinned train_model does not forward clear_cache_threshold itself.
        kwargs['args'].clear_cache_threshold = args.clear_cache_threshold
        actual = dict(tree_flatten(model.trainable_parameters()))
        parent = mx.load(plan['parent_adapter'])
        if set(actual) != set(parent) or not all(actual[k].shape == v.shape and mx.array_equal(actual[k],v).item() for k,v in parent.items()):
            raise ValueError('Exact parent adapter was not loaded into all trainable parameters')
        del actual, parent
        selected=subset_module.restrict_trainables(model,plan['hyperparameters'].get('trainable_last_layers',16))
        trained_keys=set(selected)
        print(json.dumps({'event':'declared_trainable_subset','last_layers':plan['hyperparameters'].get('trainable_last_layers',16),'parameters':sum(v.size for v in selected.values()),'tensors':len(trained_keys)}),flush=True)
        recorder.optimizer = kwargs['optimizer']
        return pinned_train(**kwargs, loss=loss_module.assistant_target_loss)
    lora.train = verified_train
    lora.train_model(args, model, train, valid, recorder)
    # Pinned trainer saves trainable tensors only. Complete every snapshot with
    # untouched parent tensors so inference never receives a partial adapter.
    frozen_parent=mx.load(plan['parent_adapter'])
    for checkpoint_name in ['adapters.safetensors']+[f'{i:07d}_adapters.safetensors' for i in (12,24,36,48) if mode=='train']:
        checkpoint=output/checkpoint_name
        subset=mx.load(str(checkpoint))
        complete=subset_module.complete_adapter(frozen_parent,subset,trained_keys)
        mx.save_safetensors(str(checkpoint),complete)
    del frozen_parent, subset, complete
    expected_updates = args.iters // args.grad_accumulation_steps
    if not update_events or update_events[-1]['completed_optimizer_updates'] != expected_updates:
        raise ValueError('Final completed optimiser update count is not proven')
    final_weights = mx.load(str(output/'adapters.safetensors'))
    parent_weights = mx.load(plan['parent_adapter'])
    if set(final_weights) != set(parent_weights):
        raise ValueError('Final adapter/trainable key mismatch')
    changed = sum(not mx.array_equal(value,parent_weights[key]).item() for key,value in final_weights.items())
    finite = all(mx.all(mx.isfinite(value)).item() for value in final_weights.values())
    if changed < 1 or not finite:
        raise ValueError('Final trainable parameters did not change finitely from the parent')
    with (plan_path.parent/'optimizer-update-accounting.json').open('x') as stream:
        json.dump({'trainer':'mlx-lm','pinned_version':'0.31.3','cli_iters_meaning':'microbatch_iterations',
                   'microbatches':args.iters,'gradient_accumulation_steps':args.grad_accumulation_steps,
                   'completed_optimizer_updates':expected_updates,'presented_examples':args.iters*args.batch_size,
                   'eligible_training_examples':len(train),'changed_trainable_tensors':changed,
                   'all_final_trainable_parameters_finite':finite,'events':update_events},stream,indent=2)
    # MLX logs validation BEFORE an iteration's update but persists weights AFTER
    # it. Never attach that printed loss to the following saved checkpoint.
    if mode == 'train':
        exact = []
        for iteration in (12, 24, 36, 48):
            checkpoint = output / f'{iteration:07d}_adapters.safetensors'
            model.load_weights(str(checkpoint), strict=False)
            mx.eval(model.parameters())
            loss = float(evaluate(model, CacheDataset(valid), batch_size=1,
                                  num_batches=-1, max_seq_length=args.max_seq_length,
                                  loss=loss_module.assistant_target_loss))
            exact.append({'iteration': iteration, 'validation_loss': loss,
                          'path': str(checkpoint), 'sha256': digest(checkpoint)})
            print(json.dumps({'event': 'exact_checkpoint_validation', **exact[-1]}), flush=True)
        with (plan_path.parent / 'exact-checkpoint-validation.json').open('x') as stream:
            json.dump({'records': exact, 'validation_sha256': digest(Path(plan['dataset'])/'valid.jsonl'),
                       'training_validation_events': validation_events}, stream, indent=2)
    print(json.dumps({'event':'training_finished','mode':mode,'adapter_sha256':digest(output/'adapters.safetensors')}),flush=True)


if __name__ == '__main__':
    main()
