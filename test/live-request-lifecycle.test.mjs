import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function harness({fetch=async()=>new Response('{}',{headers:{'content-type':'application/json'}}), fast=false,noOpen=false,sendFails=false}={}) {
 const sockets=[];
 class Socket extends EventTarget {
  static OPEN=1; readyState=0; sent=[];
  constructor(){super();sockets.push(this);if(!noOpen) queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))});}
  send(raw){if(sendFails) throw Error("send failed");this.sent.push(JSON.parse(raw));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  frame(data){this.dispatchEvent(new MessageEvent('message',{data:typeof data==='string'?data:JSON.stringify(data)}));}
 }
 const input={value:''}; const app={currentUser:'alex-morgan',pendingChat:new Map(),chatMessages:[],chatSources:[],sessionId:null};
 const ctx=vm.createContext({app,fetch,AbortController,WebSocket:Socket,location:{protocol:'http:',host:'localhost'},crypto:{randomUUID},console,sessionStorage:{setItem(){},getItem(){return null},removeItem(){}},setTimeout:(fn,ms)=>setTimeout(fn,fast?Math.min(ms,20):ms),clearTimeout,renderAssistant(){},renderChatLog(){},$(){return input},Event});
 vm.runInContext(source.slice(source.indexOf('function chatError('),source.indexOf('\nfunction $('))+source.slice(source.indexOf('const CHAT_COMPLETION_MS'),source.indexOf('\nasync function refreshLocalModelStatus')),ctx);
 return {ctx,app,input,sockets,call:(code)=>vm.runInContext(code,ctx)};
}
const tick=()=>new Promise(r=>setImmediate(r));
const completed=(id)=>({event:'chat.completed',request_id:id,session_id:'session',message_id:'answer',response:'Supported completed answer',sources:[],confidence:'grounded'});
test('DEVELOPMENT_ONLY: HTTP 401/403/429/500 and malformed success are explicit failures',async()=>{
 for(const status of [401,403,429,500]){const h=harness({fetch:async()=>new Response('private stack',{status})});await assert.rejects(h.call('fetchJson("/chat")'),e=>e.code===`HTTP_${status}`&&!e.message.includes('private'));}
 for(const [body,type] of [['','application/json'],['{','application/json'],['null','application/json'],['[]','application/json'],['<html>oops</html>','text/html']]){const h=harness({fetch:async()=>new Response(body,{headers:{'content-type':type}})});await assert.rejects(h.call('fetchJson("/chat")'),e=>e.code==='INVALID_PAYLOAD');}
});
test('DEVELOPMENT_ONLY: successful answer survives unavailable history',async()=>{
 let fetches=0;const h=harness({fetch:async()=>{fetches++;throw Error('history offline')}});h.input.value='question';const run=h.call('handleAssistantSubmit(new Event("submit"))');await tick();const socket=h.sockets[0],id=socket.sent[0].client_request_id;socket.frame(completed(id));await run;
 assert.match(h.app.chatMessages.at(-1).text,/Supported completed answer/);assert.equal(h.app.chatMessages.at(-1).pending,false);assert.equal(fetches,1);assert.equal(h.app.pendingChat.size,0);
});
test('DEVELOPMENT_ONLY: disconnect after send settles without HTTP replay',async()=>{
 let fetches=0;const h=harness({fetch:async()=>{fetches++;throw Error()}});h.input.value='question';const run=h.call('handleAssistantSubmit(new Event("submit"))');await tick();h.sockets[0].close();await run;assert.equal(h.app.lastChatFailure.code,'DISCONNECTED');assert.equal(h.app.pendingChat.size,0);assert.equal(fetches,0);assert.equal(h.app.activeChat,null);
});
test('DEVELOPMENT_ONLY: missing terminal frame has bounded TIMEOUT',async()=>{const h=harness({fast:true});h.input.value='question';await h.call('handleAssistantSubmit(new Event("submit"))');assert.equal(h.app.lastChatFailure.code,'TIMEOUT');assert.equal(h.app.pendingChat.size,0);assert.equal(h.app.activeChat,null)});
test('DEVELOPMENT_ONLY: malformed frame and invalid completion fail closed',async()=>{for(const frame of ['{',{event:'chat.completed',response:'incomplete'}]){const h=harness();h.input.value='question';const run=h.call('handleAssistantSubmit(new Event("submit"))');await tick();const id=h.sockets[0].sent[0].client_request_id;h.sockets[0].frame(typeof frame==='string'?frame:{...frame,request_id:id});await run;assert.equal(h.app.lastChatFailure.code,'INVALID_PAYLOAD');}});
test('DEVELOPMENT_ONLY: New Chat ignores late accepted and completion events',async()=>{const h=harness();h.input.value='question';const run=h.call('handleAssistantSubmit(new Event("submit"))');await tick();const socket=h.sockets[0],id=socket.sent[0].client_request_id;h.call('resetConversation()');socket.frame({event:'chat.accepted',request_id:id,session_id:'stale'});socket.frame(completed(id));await run;assert.equal(h.app.chatMessages.length,0);assert.equal(h.app.sessionId,null);assert.equal(h.app.pendingChat.size,0)});
test('DEVELOPMENT_ONLY: repeated submits serialize; cancel retains deliberate retry question',async()=>{const h=harness();h.input.value='first';const first=h.call('handleAssistantSubmit(new Event("submit"))');await tick();h.input.value='second';await h.call('handleAssistantSubmit(new Event("submit"))');assert.equal(h.sockets[0].sent.length,1);h.call('cancelChat()');await first;assert.equal(h.app.lastChatFailure.question,'first');assert.equal(h.app.lastChatFailure.code,'CANCELLED')});

test('DEVELOPMENT_ONLY: timed-out socket closes and late open cannot become active',async()=>{const h=harness({fast:true,noOpen:true});await assert.rejects(h.call('connectChatSocket()'),e=>e.code==='CONNECTION_TIMEOUT');const socket=h.sockets[0];socket.readyState=1;socket.dispatchEvent(new Event('open'));assert.equal(socket.readyState,3);assert.equal(h.app.chatSocket,undefined)});
test('DEVELOPMENT_ONLY: synchronous send failure cleans pending state',async()=>{const h=harness({sendFails:true});h.input.value='question';await h.call('handleAssistantSubmit(new Event("submit"))');assert.equal(h.app.pendingChat.size,0);assert.equal(h.app.lastChatFailure.code,'NETWORK')});
test('DEVELOPMENT_ONLY: HTTP network and deadline categories are distinct',async()=>{const network=harness({fetch:async()=>{throw Error('fetch failed')}});await assert.rejects(network.call('fetchJson("/chat")'),e=>e.code==='NETWORK');const timeout=harness({fast:true,fetch:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});await assert.rejects(timeout.call('fetchJson("/chat")'),e=>e.code==='TIMEOUT')});
test('DEVELOPMENT_ONLY: wrong request identity cannot change a pending message',async()=>{const h=harness();h.input.value='question';const run=h.call('handleAssistantSubmit(new Event("submit"))');await tick();h.sockets[0].frame({event:'chat.status',request_id:'other-user-request',status:'generating'});assert.equal(h.app.chatMessages.at(-1).text,'Submitting your question…');h.call('cancelChat()');await run});
