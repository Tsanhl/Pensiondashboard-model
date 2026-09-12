import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const ROOT=resolve(import.meta.dirname,'../../approved-materials');
const PACKAGE='live-repair-20260908/protective-notice.json';
const EXPECTED='17c6417a284e21cd19430e75c80aaab57d09c15278f8da198a83bb8f4e5c1d7e';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const basic='Basic safety notice: Pause any pension transfer decision while you check the concern. Contact your pension provider directly. Reviewed guidance is currently unavailable.';

export function loadProtectiveNotice({now=Date.now(),read=path=>readFileSync(path)}={}) {
  try {
    const bytes=read(resolve(ROOT,PACKAGE));
    if(hash(bytes)!==EXPECTED)throw new Error('Package mismatch');
    const data=JSON.parse(bytes);
    if(now>=Date.parse(data.review_after)||now<Date.parse(data.reviewed_at))throw new Error('Outside review window');
    const paths=[{path:data.review.packet_path,sha256:data.review.packet_sha256},...data.review.files];
    for(const entry of paths){const path=resolve(ROOT,entry.path);if(!path.startsWith(ROOT+'/')||hash(read(path))!==entry.sha256)throw new Error('Review evidence mismatch');}
    const packet=JSON.parse(read(resolve(ROOT,data.review.packet_path)));
    if(packet.items.find(x=>x.item_id==='protective-notice-v2')?.proposed_text!==data.text)throw new Error('Unreviewed wording');
    const sources=data.sources.map(source=>{
      const evidence=packet.evidence.find(x=>x.evidence_id===source.source_id);
      return {...source,snippet:evidence.content || [evidence.quote,evidence.research_summary].filter(Boolean).join('\n')};
    });
    const claims=data.text.match(/[^.!?]+[.!?]*/g).map(text=>({claim:text.trim(),source_ids:sources.map(x=>x.source_id)}));
    return {response:`General safety notice: ${data.text}`,sources,claim_citations:claims,reviewed:true,
      validation:{valid:true,reason:'independently_reviewed_protective_notice',scope:data.scope,version:data.version,package_sha256:EXPECTED,review_after:data.review_after,formal_credit:false}};
  } catch {
    return {response:basic,sources:[],claim_citations:[],reviewed:false,validation:{valid:false,reason:'protective_notice_review_unavailable',formal_credit:false}};
  }
}
