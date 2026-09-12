import json
from pathlib import Path
import sys
from transformers import AutoTokenizer
from mlx_lm.tuner.datasets import ChatDataset
p=Path(sys.argv[1]).resolve(strict=True)
tok=AutoTokenizer.from_pretrained('models/mlx/Qwen3-8B-4bit',local_files_only=True,trust_remote_code=False)
rows=[]
for part in ['train','valid']:
 for r in map(json.loads,(p/(part+'.jsonl')).read_text().splitlines()):
  m=r['messages'];full=tok.apply_chat_template(m,enable_thinking=False,return_dict=False);prefix=tok.apply_chat_template(m[:-1],enable_thinking=False,add_generation_prompt=True,return_dict=False)
  default,offset=ChatDataset([r],tok,mask_prompt=True).process(r)
  rows.append({'id':r['metadata']['training_id'],'part':part,'total':len(full),'completion':len(full)-len(prefix),'prefix_matches':full[:len(prefix)]==prefix,'default_prefix_matches_serving':default[:offset]==prefix,'default_offset':offset,'serving_offset':len(prefix)})
result={'rows':rows,'maximum_tokens':max(r['total'] for r in rows),'max_completion':max(r['completion'] for r in rows),'prefix_all_match':all(r['prefix_matches'] for r in rows),'default_serving_match':all(r['default_prefix_matches_serving'] for r in rows),'serving_enable_thinking':False}
with (p/'tokenizer-preflight.json').open('x') as f:json.dump(result,f,indent=2)
print(json.dumps({k:v for k,v in result.items() if k!='rows'},indent=2))
if not result['prefix_all_match'] or result['max_completion']>192:sys.exit(1)
