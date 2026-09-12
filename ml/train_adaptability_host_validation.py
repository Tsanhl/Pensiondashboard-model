"""Run unchanged proven trainer with its proven per-example validation approach."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
plan=json.loads(Path(sys.argv[1]).read_text())
patch=plan['validation_aggregation']
for record in patch['bound_inputs']:
    if digest(record['path'])!=record['sha256']:raise ValueError('Validation compatibility patch changed')
spec=importlib.util.spec_from_file_location('host_validation',Path(__file__).with_name('adaptability_validation.py'))
validation=importlib.util.module_from_spec(spec);spec.loader.exec_module(validation)
import mlx_lm.tuner.trainer as trainer
trainer.evaluate=validation.evaluate
spec=importlib.util.spec_from_file_location('proven_training_runner',Path(__file__).with_name('train_adaptability.py'))
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
print(json.dumps({'event':'validation_compatibility_patch','scope':'host-scalar aggregation only; unchanged gradient trainer','patch_sha256':digest(Path(__file__))}),flush=True)
runner.main()
