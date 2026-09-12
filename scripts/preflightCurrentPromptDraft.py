"""No model weights: exact serving wrapper, full-context and target-mask checks."""
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ml'))
from train_adaptability import ServingTokenizer
from assistant_target_loss import validate_target_window
from transformers import AutoTokenizer
from mlx_lm.tuner.datasets import ChatDataset
root=Path(sys.argv[1]).resolve(strict=True);maximum=int(sys.argv[2]) if len(sys.argv)>2 else 3584
if maximum not in (3584,3680):raise ValueError('Unreviewed sequence envelope')
output=root/('serving-wrapper-preflight.json' if maximum==3584 else f'serving-wrapper-preflight-{maximum}.json')
if output.exists():raise ValueError('Preserve existing preflight')
tokenizer=ServingTokenizer(AutoTokenizer.from_pretrained('models/mlx/Qwen3-8B-4bit',local_files_only=True,trust_remote_code=False))
rows=[]
for partition,expected in [('train',24),('valid',8)]:
    data=[json.loads(line) for line in (root/(partition+'.jsonl')).read_text().splitlines()]
    if len(data)!=expected:raise ValueError('Unexpected split')
    for row in data:
        tokens,offset=ChatDataset([row],tokenizer,mask_prompt=True).process(row)
        prefix=tokenizer.apply_chat_template(row['messages'][:-1],add_generation_prompt=True,return_dict=False)
        reason=None
        try:validate_target_window(len(tokens),offset,maximum)
        except ValueError as error:reason=str(error)
        rows.append({'id':row['metadata']['training_id'],'partition':partition,'tokens':len(tokens),'offset':offset,
            'completion_tokens':len(tokens)-offset,'serving_prefix_exact':tokens[:offset]==prefix,
            'untruncated_context_fits':len(tokens)<=maximum,'target_window_valid':reason is None,'failure':reason})
result={'scope':'TOKENIZER_ONLY_NOT_MODEL_OR_TRAINING_APPROVAL','max_seq_length':maximum,'maximum_observed_tokens':max(x['tokens'] for x in rows),
    'rows':rows,'passed':all(x['serving_prefix_exact'] and x['untruncated_context_fits'] and x['target_window_valid'] for x in rows),
    'dataset_hashes':{part:hashlib.sha256((root/(part+'.jsonl')).read_bytes()).hexdigest() for part in ('train','valid')},
    'full_model_loaded':False,'training_updates':0}
with output.open('x') as stream:json.dump(result,stream,indent=2)
print(json.dumps({k:v for k,v in result.items() if k!='rows'}))
sys.exit(0 if result['passed'] else 1)
