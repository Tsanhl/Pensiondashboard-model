import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {boundedFileDigest as hash} from './lib/boundedFileDigest.mjs';
const [sourceArg,rootArg]=process.argv.slice(2);if(!sourceArg||!rootArg)throw Error('Reviewed source and fresh repair root required');
const source=resolve(sourceArg),root=resolve(rootArg);if(existsSync(root))throw Error('Fresh repair root required');
const packet=JSON.parse(readFileSync(resolve(source,'review-packet.json')));
const review=JSON.parse(readFileSync(resolve(source,'review/source-admission-review.json')));
if(packet.version!=='pdu50-workplace-guidance-capture-v1'||review.passed||!review.reviewer_outputs.some(x=>x.items.some(i=>i.item_id==='PUB_JOIN'&&i.verdict==='HOLD')))throw Error('Declared scope HOLD required');
const use='Explain the guide’s enrolment overview with its stated conditions. Re-enrolment is outside this source scope. Do not decide a particular person’s eligibility or assert territorial statutory equivalence from this summary alone.';
packet.version='pdu50-workplace-guidance-scope-repair-v2';packet.items.find(x=>x.item_id==='PUB_JOIN').proposed_use=use;
packet.evidence.find(x=>x.metadata.id==='PUB_JOIN').metadata.scope_note=use;
mkdirSync(root,{mode:0o700});for(const name of ['official-content.json','PUB_CONTRIB.html','PUB_LEAVE.html','PUB_JOIN.html'])copyFileSync(resolve(source,name),resolve(root,name));
writeFileSync(resolve(root,'review-packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'repair-receipt.json'),JSON.stringify({parent_review:resolve(source,'review/source-admission-review.json'),parent_review_sha256:hash(resolve(source,'review/source-admission-review.json')),
 change:'Removed unsupported re-enrolment use; original fetched bytes and other source scopes unchanged.',maximum_additional_reviewer_calls:2,automatic_retry:false,corpus_changed:false},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,changed:'PUB_JOIN scope only',original_review_preserved:true}));
