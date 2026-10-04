'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const acorn=require('acorn');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {source,responseBundle:frontend}=require('./release-fixture.cjs');
const host=source.host;
function parseAt(text,start){
  let node=acorn.parseExpressionAt(text,start,{ecmaVersion:'latest'});
  if(node.type==='SequenceExpression')node=node.expressions[0];
  return text.slice(node.start,node.end);
}
const marker='"queued-follow-up-send-lock-release":';
const releaseCode=parseAt(host,host.indexOf(marker)+marker.length);
assert.match(releaseCode,/this\.queuedFollowUpSendLocks\.release/);
const responseStart=host.indexOf('return{type:"fetch-response",responseType:"success",requestId:e.requestId,status:200,headers:{},bodyJsonString:');
assert.ok(responseStart>=0);
const responseCode=parseAt(host,responseStart+'return'.length);
const methodStart=frontend.indexOf('onFetchResponse(e){');
const methodEnd=frontend.indexOf('async get(',methodStart);
assert.ok(methodStart>=0&&methodEnd>methodStart);
const parser=vm.runInNewContext('({'+frontend.slice(methodStart,methodEnd)+'})').onFetchResponse;
function response(value,fixed=false){
  const code=fixed?responseCode.replace('JSON.stringify(o)','JSON.stringify(o??null)'):responseCode;
  return vm.runInNewContext('('+code+')',{e:{requestId:'test'},o:value});
}
function receive(payload){
  const state={pendingRequests:new Map(),cleaned:0};
  const result=new Promise((resolve,reject)=>state.pendingRequests.set('test',{resolve,reject,cleanup:()=>state.cleaned++}));
  parser.call(state,payload);
  return{result,state};
}
test('OFFICIAL 51102: real lock-release handler performs release but returns undefined',async()=>{
  const calls=[];
  const release=vm.runInNewContext('('+releaseCode+')',{queuedFollowUpSendLocks:{release:params=>calls.push(params)}});
  const args={conversationId:'thread',messageId:'message',lockId:'lock',sent:true};
  const value=await release(args);
  assert.equal(calls.length,1);
  assert.equal(calls[0].sent,true);
  assert.equal(value,undefined);
  assert.equal(response(value).bodyJsonString,undefined);
});
test('OFFICIAL 51102: real response parser rejects undefined JSON after cleaning pending request',async()=>{
  const {result,state}=receive(response(undefined));
  await assert.rejects(result,/undefined.*not valid JSON|Unexpected token.*undefined/);
  assert.equal(state.pendingRequests.size,0);
  assert.equal(state.cleaned,1);
});
test('REPAIR CANDIDATE 51102: null serialization passes the same real response parser',async()=>{
  const payload=response(undefined,true);
  assert.equal(payload.bodyJsonString,'null');
  const {result,state}=receive(payload);
  assert.equal((await result).body,null);
  assert.equal(state.cleaned,1);
});
test('OFFICIAL 51102: nonempty successful response remains readable',async()=>{
  const {result}=receive(response({acquired:true}));
  assert.equal((await result).body.acquired,true);
});
