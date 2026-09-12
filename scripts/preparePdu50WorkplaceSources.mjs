// Capture official public guidance, not private scenarios or evaluator answers.
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||'');if(!process.argv[2]||existsSync(root))throw Error('Fresh source output directory required');
const url='https://www.gov.uk/api/content/workplace-pensions';
const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
if(!response.ok)throw Error('Official source retrieval failed: '+response.status);
const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>2e6)throw Error('Unexpected source size');
const source=JSON.parse(bytes),at=new Date().toISOString();
if(source.base_path!=='/workplace-pensions'||!Array.isArray(source.details?.parts))throw Error('Unexpected GOV.UK content identity');
const hash=value=>createHash('sha256').update(value).digest('hex');
const scopes=[
  ['PUB_CONTRIB','what-you-your-employer-and-the-government-pay','Explain the guide’s distinction between scheme-specific contribution bases, employer contributions and salary sacrifice. Do not treat its simplified examples or minimum figures as proof of an individual payroll entitlement, extra matching or complete applicable law.'],
  ['PUB_LEAVE','changing-jobs-and-taking-leave','Explain the guide’s job-change, paid-leave and unpaid-leave distinctions, including scheme-dependent qualifications. Do not treat its summary as exhaustive statutory maternity rights or a guarantee about a particular scheme.'],
  ['PUB_JOIN','joining-a-workplace-pension','Explain the guide’s enrolment overview with its stated conditions. Re-enrolment is outside this source scope. Do not decide a particular person’s eligibility or assert territorial statutory equivalence from this summary alone.']
];
mkdirSync(root,{recursive:true,mode:0o700});
writeFileSync(resolve(root,'official-content.json'),bytes,{flag:'wx',mode:0o600});
const evidence=[],items=[];
for(const [id,slug,use] of scopes){
  const part=source.details.parts.find(x=>x.slug===slug);if(!part?.body)throw Error('Missing official guide part '+slug);
  const canonical='https://www.gov.uk/workplace-pensions/'+slug;
  const metadata={id,title:part.title,authority:'GOV.UK',canonical_location:canonical,
    capture_endpoint:url,raw_sha256:hash(bytes),content_sha256:hash(part.body),retrieved_at:at,
    public_updated_at:source.public_updated_at??null,effective_date:null,
    jurisdiction:'UK public guidance; provision-level territorial applicability not established by this capture',
    source_type:'official_guidance',licence:'Open Government Licence v3.0, subject to page exceptions',
    locator:'GOV.UK content API details.parts[slug='+slug+'].body',
    scope_note:use,freshness_limit:'Capture-date guidance only. Not an as-of-2026-09-10 or current-law certification. Recheck legal dates, territorial scope and original applicable provisions before case-label approval.'};
  writeFileSync(resolve(root,id+'.html'),part.body,{flag:'wx',mode:0o600});
  evidence.push({evidence_id:'SRC:'+id,metadata,content:part.body});
  items.push({item_id:id,evidence_ids:['SRC:'+id],proposed_use:use,
    admission:'Guidance source review only, not legal label approval, product scoring or admission into the active corpus.',
    freshness:metadata.freshness_limit});
}
const packet={scope:'DEVELOPMENT_SOURCE_ADMISSION_ONLY',version:'pdu50-workplace-guidance-capture-v1',items,evidence};
writeFileSync(resolve(root,'review-packet.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(root,'capture-receipt.json'),JSON.stringify({at,url,status:response.status,raw_sha256:hash(bytes),packet_sha256:hash(JSON.stringify(packet,null,2)),sources:3,active_corpus_modified:false,review:'PENDING'},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,sources:3,review:'PENDING',active_corpus_modified:false}));
