'use strict';
const fs=require('node:fs'),vm=require('node:vm'),acorn=require('acorn');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {source,responseBundle:plugins}=require('./release-fixture.cjs');
const fresh=source.coordinator;
const json=x=>JSON.parse(JSON.stringify(x));
function expression(code,start){
  let node=acorn.parseExpressionAt(code,start,{ecmaVersion:'latest'});
  if(node.type==='SequenceExpression')node=node.expressions[0];
  return code.slice(node.start,node.end);
}
function fn(code,name){return expression(code,code.indexOf('function '+name+'('));}
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject};}
function cloudEnvironment(){
  const handlers=new Map();let disposed=0;
  const thread={turnHistory:{kind:'canonical',history:{isComplete:false}},resumeState:'resuming',boundedCloudHistory:true};
  const client={getHostId:()=> 'cloud',getConversation:()=>thread,subscribe:({field,listener})=>{handlers.set(field,listener);return()=>{disposed++;handlers.delete(field);};}};
  const wait=vm.runInNewContext(fn(fresh,'Y_n')+';'+fn(fresh,'X_n')+';X_n',{Pe:deferred});
  return{handlers,thread,client,wait,getDisposed:()=>disposed};
}
for(const field of ['boundedCloudHistoryReady','compactHistoryComplete'])test(`OFFICIAL 31730 data: ${field} completes a waiting cloud history load`,async()=>{
  const e=cloudEnvironment(),pending=deferred();
  const done=e.wait(e.client,'thread',pending.promise);
  assert.equal(e.handlers.size,2);
  e.thread.turnHistory.history.isComplete=true;
  e.handlers.get(field)();
  await done;
  assert.equal(e.getDisposed(),2);
  assert.equal(e.handlers.size,0);
});
test('OFFICIAL 31730 data: failed cloud load disposes both history subscriptions',async()=>{
  const e=cloudEnvironment(),pending=deferred();
  const done=e.wait(e.client,'thread',pending.promise);
  pending.reject(new Error('transport unavailable'));
  await assert.rejects(done,/transport unavailable/);
  assert.equal(e.getDisposed(),2);
});
test('OFFICIAL 31730 data: incomplete history does not prematurely complete its waiter',async()=>{
  const e=cloudEnvironment(),pending=deferred();let completed=false;
  const done=e.wait(e.client,'thread',pending.promise).then(()=>{completed=true;});
  e.handlers.get('boundedCloudHistoryReady')();
  await Promise.resolve();await Promise.resolve();
  assert.equal(completed,false);
  assert.equal(e.handlers.size,2);
  e.thread.turnHistory.history.isComplete=true;
  e.handlers.get('boundedCloudHistoryReady')();await done;
  assert.equal(e.getDisposed(),2);
});
const guard=plugins.indexOf('Used plugins history returned an unchanged cursor');
const callbackStart=plugins.lastIndexOf('.map(async(',guard)+'.map('.length;
assert.ok(guard>=0&&callbackStart>0);
const scanCode=expression(plugins,callbackStart);
assert.match(scanCode,/sortDirection:`desc`/);
function scanner(response,aborted=false){
  const calls=[],controller=new AbortController();if(aborted)controller.abort();
  const o={state:{data:{plugins:[],scannedPlugins:[]}},setState:next=>{o.state=next;}};
  const scan=vm.runInNewContext('('+scanCode+')',{i:controller.signal,n:{},Ip:{},o,jd:()=>({sendRequest:async(...args)=>{calls.push(args);return response;}}),RAt:item=>item.plugin??null});
  return{scan,calls,o};
}
test('OFFICIAL 31730 data: repeated non-null plugin history cursor fails instead of looping',async()=>{
  const e=scanner({data:[],nextCursor:'same'});
  await assert.rejects(e.scan({threadId:'thread',cursor:'same'}),/unchanged cursor/);
  assert.equal(e.calls.length,1);
});
test('OFFICIAL 31730 data: final plugin history page retires its scan',async()=>{
  const e=scanner({data:[{item:{plugin:{id:'plugin',name:'Plugin'}}}],nextCursor:null});
  assert.deepEqual(json(await e.scan({threadId:'thread',cursor:null})),[]);
  assert.equal(e.o.state.data.plugins[0].id,'plugin');
  assert.equal(e.calls[0][1].sortDirection,'desc');
});
test('OFFICIAL 31730 data: one page preserves continuation and deduplicates plugin IDs',async()=>{
  const plugin={id:'plugin',name:'Plugin'},e=scanner({data:[{item:{plugin}},{item:{plugin}}],nextCursor:'older'});
  assert.deepEqual(json(await e.scan({threadId:'thread',cursor:null})),[{threadId:'thread',cursor:'older'}]);
  assert.equal(e.o.state.data.plugins.length,1);
  assert.equal(e.o.state.data.scannedPlugins.length,1);
});
test('OFFICIAL 31730 data: aborted plugin scan sends no transport request',async()=>{
  const e=scanner({data:[],nextCursor:null},true);
  await assert.rejects(e.scan({threadId:'thread',cursor:null}),error=>error.name==='AbortError');
  assert.equal(e.calls.length,0);
});
