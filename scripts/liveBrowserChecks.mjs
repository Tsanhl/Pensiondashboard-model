// Finite development browser matrix. No qualification-bank discovery or imports.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const modulePath=process.env.PLAYWRIGHT_MODULE_PATH;
if(!modulePath) throw new Error('Set PLAYWRIGHT_MODULE_PATH to the installed, inspected Playwright module.');
const {chromium}=require(modulePath);
const origin='http://127.0.0.1:3001';
const output=resolve(process.env.PENSION_BROWSER_OUTPUT || '');
if(!process.env.PENSION_BROWSER_OUTPUT || existsSync(resolve(output,'receipt.json'))) throw new Error('A fresh explicit evidence directory is required.');
mkdirSync(output,{recursive:true,mode:0o700});
const questions=JSON.parse(readFileSync(new URL('../test/fixtures/live-repair/owner-questions.json',import.meta.url))).questions;
const browser=await chromium.launch({channel:'chrome',headless:true});
const results=[];
let matrixCompleted=false;
async function scenario(name,user,setup,exercise){
 const context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.addInitScript(user=>{localStorage.setItem('pension-plan-active-user-v1',user);localStorage.setItem('pension-plan-refined-ui-v1','assistant');},user);
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 const page=await context.newPage(),requests=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().endsWith('/chat')&&r.method()==='POST')requests.push({transport:'HTTP',body:r.postDataJSON()});});
 page.on('websocket',ws=>ws.on('framesent',frame=>{try{const data=JSON.parse(frame.payload);if(data.event==='chat.message'||data.type==='chat.message'||data.message)requests.push({transport:'WS',body:data});}catch{}}));
 const record={name,scope:'DEVELOPMENT_ONLY',user,started_at:new Date().toISOString()};
 try{
   await setup?.({page,context,requests});
   await page.goto(origin+'/#assistant');
   await page.locator('#assistant-input').waitFor({state:'visible'});
   await page.waitForFunction(()=>document.querySelector('#profile-name')?.textContent && !document.body.dataset.portfolioUnavailable);
   await exercise({page,context,requests,record});
   assert.deepEqual(errors,[],'Uncaught browser exceptions');
   record.passed=true;
 }catch(e){record.passed=false;record.error=e.message;}
 record.browser_errors=errors;record.requests=requests.map(x=>({transport:x.transport,request_id:x.body.client_request_id||x.body.request_id,message:x.body.message}));
 record.visible_text=await page.locator('#chat-log').innerText().catch(()=> 'UI unavailable');
 await page.screenshot({path:resolve(output,name+'.png'),fullPage:true}).catch(()=>{});
 await context.tracing.stop({path:resolve(output,name+'.zip')});
 await context.close();results.push(record);
 writeFileSync(resolve(output,'progress.json'),JSON.stringify(results,null,2));console.log(name,record.passed?'PASS':'FAIL',record.error||'');
}
async function ask(page,message){
 await page.locator('#assistant-input').fill(message);
 await page.locator('#assistant-form button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#chat-log [data-state="pending"]') && !document.querySelector('#assistant-form button[type=submit]').disabled,{},{timeout:325000});
 return page.locator('#chat-log .assistant').last().innerText();
}
async function recover(page,requests){
 const n=requests.length,text=await ask(page,questions[3]);assert.match(text,/extracted|No documents with Review/i);assert.equal(requests.length,n+1);
}
try{
 const group=process.env.PENSION_BROWSER_GROUP || 'all';
 if(!['all','healthy','legal','conversation','serving-repair','hybrid-targeted','faults','dependencies','live-cancel'].includes(group))throw Error('Unknown browser matrix group');
 if(group==='all'||group==='healthy'){
  await scenario('healthy-ws-Q2-Q6','alex-morgan',null,async({page,requests,record})=>{
   const replies=[];record.answers={};
   for(const i of [1,2,3,4,5]) {
    const start=Date.now();replies[i]=await ask(page,questions[i]);record.answers[`Q${i+1}`]={text:replies[i],ms:Date.now()-start};
    if(i===1){
     assert.match(replies[i],/General safety notice/);
     const links=page.locator('.assistant-source a');assert.ok(await links.count()>0,'Official source link absent');
     const href=await links.first().getAttribute('href');assert.match(href,/^https:\/\//);
     await page.locator('.assistant-source details').first().click();assert.ok((await page.locator('.assistant-source details[open]').innerText()).length>100);
     const citationPage=await page.context().newPage();const response=await citationPage.goto(href,{waitUntil:'domcontentloaded',timeout:30000});
     record.citation={href,final_url:citationPage.url(),status:response.status()};assert.ok(response.ok());assert.match(await citationPage.locator('body').innerText(),/pension|scam/i);await citationPage.close();
    }
   }
   assert.match(replies[2],/scenario/i);assert.match(replies[3],/extracted/i);assert.match(replies[4],/clarif|which|question/i);assert.match(replies[5],/failed|failure|question|request/i);
   assert.equal(requests.length,3);assert.ok(requests.every(x=>x.transport==='WS'));
   await page.reload();await page.locator('#assistant-input').waitFor({state:'visible'});
   await page.waitForFunction(()=>document.querySelectorAll('#chat-log .user').length===3);
   assert.equal(requests.length,3,'Reload must not regenerate');
  });
  await scenario('healthy-http-empty-profile','empty-demo',null,async({page,requests})=>{
   const reply=await ask(page,questions[2]);assert.match(reply,/No pension accounts/);assert.doesNotMatch(reply,/Aviva|Nest|OneLife|Northbridge/);
   assert.equal(requests.length,1);assert.equal(requests[0].transport,'HTTP');
   await recover(page,requests);
  });
 }
 if(group==='all'||group==='legal'||group==='serving-repair'||group==='hybrid-targeted'){
  for(const [name,user,message] of [['Q1-live','alex-morgan',questions[0]],['Q1-paraphrase','alex-morgan','Does the company need my approval to lower future pension payments?'],['Q1-non-demo','empty-demo','Can my employer alter my pension benefits in England?']]){
   await scenario(name,user,null,async({page,requests,record})=>{
    const start=Date.now(),answer=await ask(page,message);record.answer_ms=Date.now()-start;
    assert.equal(requests.length,1);assert.doesNotMatch(answer,/not have enough|unavailable|could not|failed/i,'Legal answer prerequisite remains unmet');
    assert.match(answer,/scheme|pension/i);assert.match(answer,/which|what change|confirm|rules/i);
    assert.doesNotMatch(answer,/cannot change (?:the )?(?:subsisting rights|accrued benefits)/i);
   });
  }
 }
 if(group==='all'||group==='conversation'||group==='serving-repair'||group==='hybrid-targeted'){
  await scenario('legal-facts-supplied-next-turn','empty-demo',null,async({page,requests,record})=>{
   record.answers=[];
   for(const message of [questions[0],'It is an occupational defined-contribution scheme in England. The proposal reduces future employer contributions from 6% to 4%. What should I check?']){
    const started=Date.now(),text=await ask(page,message);record.answers.push({question:message,text,ms:Date.now()-started});
   }
   assert.equal(requests.length,2,'Exactly one execution for each intentional turn');
   const answer=record.answers[1].text;
   assert.doesNotMatch(answer,/not have enough|unavailable|could not|failed/i,'Supplied-facts follow-up must produce a supported answer');
   assert.doesNotMatch(answer,/what (?:type|kind) of (?:pension|scheme)|which (?:country|jurisdiction)|where (?:are you|is the scheme)/i,'Do not ask again for supplied scheme/jurisdiction');
   assert.match(answer,/consult|rules|requirement|condition/i);
   assert.ok(await page.locator('.assistant-source a').count()>0,'Source support absent from conversation');
   assert.doesNotMatch(answer,/Aviva|Nest|OneLife|Northbridge/i,'Empty-user conversation must not contain demo provider facts');
  });
 }
 if(group==='hybrid-targeted'){
  await scenario('owner-legal-route','alex-morgan',null,async({page,requests,record})=>{
   const message='Check the legal route for changing my workplace pension scheme.';
   const started=Date.now(),answer=await ask(page,message);record.answer_ms=Date.now()-started;
   assert.equal(requests.length,1);assert.doesNotMatch(answer,/not have enough|could not|cannot present|unavailable|failed/i);
   assert.match(answer,/scheme|pension/i);assert.ok(await page.locator('.assistant-source a').count()>0);
  });
 }
 if(group==='all'||group==='live-cancel'){
  await scenario('live-model-cancel-and-next-request','alex-morgan',null,async({page,requests,record})=>{
   await page.locator('#assistant-input').fill(questions[0]);await page.locator('#assistant-form button[type=submit]').click();
   const waitBusy=async wanted=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const state=await(await fetch('http://127.0.0.1:8080/v1/models')).json();if(Boolean(state.busy)===wanted)return;await new Promise(r=>setTimeout(r,300));}throw Error('Owned model did not reach expected busy state');};
   await waitBusy(true);record.model_was_busy=true;const start=Date.now();await page.locator('#cancel-chat').click();
   await page.waitForFunction(()=>!document.querySelector('#assistant-form button[type=submit]').disabled);record.cancel_ms=Date.now()-start;
   assert.equal(await page.locator('#chat-log [data-state=cancelled]').count(),1);assert.equal(await page.locator('#chat-log [data-state=pending]').count(),0);
   await recover(page,requests);await waitBusy(false);record.model_settled=true;
   assert.equal(await page.locator('#chat-log [data-state=cancelled]').count(),1,'Late generation must not replace cancelled bubble');
  });
 }
 if(group==='all'||group==='dependencies'){
  for(const [name,user,port] of [['model-paused-ws','alex-morgan',8080],['retrieval-paused-http','empty-demo',8090]]){
   await scenario(name,user,null,async({page,requests,record})=>{
    const pid=Number(execFileSync('/usr/sbin/lsof',['-t','-iTCP:'+port,'-sTCP:LISTEN'],{encoding:'utf8'}).trim());
    const command=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});
    assert.match(command,port===8080?/pinnedModelServer|modelServePinned/:/ml\.embedding_server/,'Unexpected service owner');
    record.paused_pid=pid;record.command=command.trim();
    process.kill(pid,'SIGSTOP');
    try{
     await assert.rejects(fetch(`http://127.0.0.1:${port}/${port===8080?'v1/models':'health'}`,{signal:AbortSignal.timeout(300)}));
     for(const message of [questions[1],'I am being rushed to transfer my pension today']){const start=Date.now(),reply=await ask(page,message);(record.notice_ms ||= []).push(Date.now()-start);assert.match(reply,/General safety notice/);assert.ok(Date.now()-start<5000);}
    }finally{process.kill(pid,'SIGCONT');}
    await recover(page,requests);
   });
  }
 }
 if(group==='all'||group==='faults'){
  for(const status of [401,403,429,500,200]){
   await scenario(`http-${status}-recovery`,'empty-demo',async({page})=>{
    let first=true;await page.route('**/chat',async route=>{if(!first)return route.continue();first=false;await route.fulfill({status,contentType:status===200?'text/html':'application/json',body:status===200?'<html>not an answer</html>':JSON.stringify({error:'Injected service fault'})});});
   },async({page,requests})=>{const reply=await ask(page,questions[3]);assert.match(reply,/failed|could not|invalid|sign in|permission|request|service/i);assert.equal(requests.length,1);assert.ok(await page.locator('#retry-chat').isVisible());await recover(page,requests);});
  }
  await scenario('manual-retry-reconciles-accepted-request','empty-demo',async({page})=>{
   let first=true;await page.route('**/chat',async route=>{if(!first)return route.continue();first=false;await route.fetch();await route.fulfill({status:502,contentType:'application/json',body:'{"error":"terminal reply lost"}'});});
  },async({page,requests})=>{
   const reply=await ask(page,questions[3]);assert.match(reply,/failed|request|service/i);assert.equal(requests.length,1);
   await page.locator('#retry-chat').click();await page.waitForFunction(()=>!document.querySelector('#assistant-form button[type=submit]').disabled);
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('#chat-log .assistant')).some(x=>/No documents with Review/i.test(x.innerText)));
   assert.equal(requests.length,2,'Unknown session requires one explicit idempotent POST');assert.equal(requests[0].body.client_request_id,requests[1].body.client_request_id,'Retry must reuse logical request identity');assert.equal(await page.locator('#chat-log .user').count(),1);
   await recover(page,requests);
  });
  await scenario('history-sync-failure-preserves-answer','empty-demo',async({page})=>{
   await page.route('**/api/conversations/**',route=>route.fulfill({status:500,contentType:'application/json',body:'{}'}));
  },async({page,requests})=>{const reply=await ask(page,questions[2]);assert.match(reply,/No pension accounts/);assert.equal(requests.length,1);await recover(page,requests);});
  for(const fault of ['drop-before-accept','drop-after-accept','malformed','missing-terminal']){
   await scenario(`ws-${fault}`,'alex-morgan',async({page,requests})=>{
    if(fault==='missing-terminal')await page.clock.install();
    let inject=true;
    await page.routeWebSocket('**/ws/chat',ws=>{
      const server=ws.connectToServer();
      ws.onMessage(message=>{const d=JSON.parse(message);if(inject&&fault==='drop-before-accept'){inject=false;requests.push({transport:'WS',body:d});void ws.close();return;}server.send(message);});
      server.onMessage(message=>{const d=JSON.parse(message);if(inject&&d.event==='chat.accepted'){
        if(fault==='drop-after-accept'){inject=false;ws.send(message);void ws.close();return;}
        if(fault==='malformed'){inject=false;ws.send('{broken');return;}
      }
      if(inject&&fault==='missing-terminal'&&d.event==='chat.completed'){inject=false;void page.clock.runFor(320001);return;}ws.send(message);});
    });
   },async({page,requests})=>{const reply=await ask(page,questions[3]);assert.match(reply,/failed|could not|request|connection|timeout|cancelled/i);assert.equal(requests.length,1,'No automatic replay after send');await recover(page,requests);});
  }
  await scenario('cancel-new-chat-profile-separation','alex-morgan',async({page})=>{
   await page.routeWebSocket('**/ws/chat',ws=>{ws.onMessage(message=>{const d=JSON.parse(message);if(d.event==='chat.start')ws.send(JSON.stringify({event:'chat.accepted',request_id:d.client_request_id,session_id:'injected-pending'}));});});
  },async({page})=>{
   await page.locator('#assistant-input').fill(questions[0]);await page.locator('#assistant-form button[type=submit]').click();
   await page.locator('#cancel-chat').click();await page.locator('#assistant-form button[type=submit]').waitFor({state:'visible'});
   assert.equal(await page.locator('#chat-log [data-state=pending]').count(),0);
   await page.locator('#new-chat-button').click();assert.equal(await page.locator('#chat-log .user').count(),0);
   await page.locator('[data-toggle-account]').click();await page.locator('[data-account-switch="empty-demo"]').click();
   await page.waitForFunction(()=>document.querySelector('#profile-name')?.textContent==='New user');
   assert.match(await ask(page,questions[2]),/No pension accounts/);
  });
 }
 matrixCompleted=true;
}finally{
 await browser.close();writeFileSync(resolve(output,'receipt.json'),JSON.stringify({scope:'DEVELOPMENT_ONLY',formal_credit:false,matrix_completed:matrixCompleted,passed:matrixCompleted&&results.length>0&&results.every(x=>x.passed),results},null,2));
}
if(results.some(x=>!x.passed))process.exitCode=1;
