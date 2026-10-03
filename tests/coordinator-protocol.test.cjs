'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {QueueProtocolStore}=require('../queue-protocol.cjs');
const {createQueueClient}=require('../queue-client.cjs');
const {engine,message,until,json,wait}=require('./coordinator-harness.cjs');
async function fixture(t) {
  const tempRoot=await fs.realpath(os.tmpdir());
  const directory=await fs.mkdtemp(path.join(tempRoot,'codex-coordinator-v2-'));
  const stores=[],unsubscribers=[],engines=[];
  t.after(async()=>{for(const stop of unsubscribers)stop();for(const e of engines)e.instance.dispose();for(const s of stores)s.dispose();const resolved=await fs.realpath(directory);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('codex-coordinator-v2-'));await fs.rm(resolved,{recursive:true,force:true})});
  async function make(options={}) {
    const host=new QueueProtocolStore(directory);stores.push(host);
    const client=createQueueClient((method,{params})=>method==='queue-repair-read'?host.read():host.compareAndSet(params),{protocolVersion:2});
    await client.loadQueuedFollowUps();
    const storage={read:client.readQueuedFollowUps,load:client.loadQueuedFollowUps,update:client.updateQueuedFollowUps};
    const e=engine(true,storage,options);engines.push(e);
    await e.instance.executionReady;
    unsubscribers.push(client.subscribeQueuedFollowUps(()=>e.changed()));
    return{host,client,e};
  }
  return{make};
}
const ids=e=>json(e.instance.readMessages('thread')).map(m=>m.id);

test('actual owner removes A, rejects old follower A, and sends only B after reload',async t=>{
  const {make}=await fixture(t),{e,client}=await make({ready:false});
  e.instance.mutate('thread',()=>[message('A'),message('B')]);await until(e.quiet);
  const stale=json(e.instance.readMessages('thread'));
  await e.instance.removeQueuedMessage('thread','A');
  await e.instance.acceptFromFollower('thread',stale);
  assert.deepEqual(ids(e),['B']);assert.deepEqual(e.calls,[]);
  const resumed=await make({ready:false});
  await resumed.e.instance.acceptFromFollower('thread',stale);
  assert.deepEqual(ids(resumed.e),['B']);
  resumed.e.setReady(true);await until(()=>resumed.e.calls.length===1&&resumed.e.quiet());
  assert.deepEqual(resumed.e.calls.map(c=>c.id),['B']);
  assert.deepEqual((await client.loadQueuedFollowUps()).thread??[],[]);
});

test('actual Undo restores a new generation and old follower edits and deletes cannot change it',async t=>{
  const {make}=await fixture(t),{e}=await make({ready:false});
  e.instance.mutate('thread',()=>[message('A'),message('B')]);await until(e.quiet);
  const stale=json(e.instance.readMessages('thread'));
  const removed=await e.instance.removeQueuedMessage('thread','A');
  await e.instance.restoreQueuedMessage('thread',removed);
  const restored=json(e.instance.readMessages('thread')).find(m=>m.id==='A');
  assert.equal(restored.queueRepairGeneration,1);
  stale[0].text='old edit';
  await e.instance.acceptFromFollower('thread',stale);
  assert.equal(e.instance.readMessages('thread').find(m=>m.id==='A').text,'A');
  await e.instance.acceptFromFollower('thread',stale.filter(m=>m.id!=='A'),['A'],[],[{conversationId:'thread',id:'A',generation:0}]);
  assert.equal(e.instance.readMessages('thread').find(m=>m.id==='A').queueRepairGeneration,1);
  assert.deepEqual(e.calls,[]);
});

test('two actual coordinators exchange canonical state and follower Undo metadata through the RPC',async t=>{
  const {make}=await fixture(t);let receive;
  const {e:owner}=await make({ready:false,coordination:{registerBroadcastHandler:()=>()=>{},broadcast:async params=>receive?.({params,sourceClientId:'owner'})}});
  const {e:follower}=await make({ready:false,initialRole:'follower',coordination:{registerBroadcastHandler:handler=>{receive=handler;return()=>{receive=undefined}}},requestFollower:async(thread,state,_owner,discarded,restores,removals)=>{await owner.instance.acceptFromFollower(thread,state[thread],discarded,restores,removals);return{resultType:'success',result:{ok:true,messages:owner.instance.readLocalMessages(thread)}}}});
  follower.instance.mutate('thread',()=>[message('A'),message('B')]);await until(()=>owner.instance.readMessages('thread')?.length===2&&follower.quiet());
  assert.deepEqual(ids(owner),['A','B']);
  const stale=json(follower.instance.readMessages('thread'));
  const removed=await follower.instance.removeQueuedMessage('thread','A');
  assert.deepEqual(ids(owner),['B']);assert.deepEqual(ids(follower),['B']);
  await follower.instance.restoreQueuedMessage('thread',removed);
  assert.equal(owner.instance.readMessages('thread').find(m=>m.id==='A').queueRepairGeneration,1);
  assert.equal(follower.instance.readMessages('thread').find(m=>m.id==='A').queueRepairGeneration,1);
  await owner.instance.acceptFromFollower('thread',stale.filter(m=>m.id!=='A'),['A'],[],[{conversationId:'thread',id:'A',generation:0}]);
  assert.equal(owner.instance.readMessages('thread').find(m=>m.id==='A').queueRepairGeneration,1);
  assert.equal(owner.calls.length+follower.calls.length,0);
});

test('Stop then a new message with identical text uses a fresh ID and is not discarded as a duplicate',async t=>{
  const {make}=await fixture(t),{e}=await make();
  await e.send('first','same text');await until(e.quiet);
  e.interrupt();await until(e.quiet);
  await e.send('second','same text');await until(()=>e.calls.length===2&&e.quiet());
  assert.deepEqual(e.calls.map(c=>c.id),['first','second']);assert.deepEqual(e.errors,[]);
});

test('filesystem commit notifications reach a different host without waiting for fallback polling',async t=>{
  const tempRoot=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(tempRoot,'codex-queue-hints-'));
  const reader=new QueueProtocolStore(dir,()=>({}),{onHint:snapshot=>changes.push(snapshot.revision)}),writer=new QueueProtocolStore(dir);
  const changes=[];t.after(async()=>{reader.dispose();writer.dispose();const resolved=await fs.realpath(dir);assert.equal(path.dirname(resolved),tempRoot);assert.ok(path.basename(resolved).startsWith('codex-queue-hints-'));await fs.rm(resolved,{recursive:true,force:true})});
  await reader.read();changes.length=0;
  const client=createQueueClient((m,{params})=>m==='queue-repair-read'?writer.read():writer.compareAndSet(params),{protocolVersion:2});
  await client.updateQueuedFollowUps(()=>({thread:[message('notify')]}));
  await until(()=>changes.length>0,'cross-host filesystem notification');
  assert.equal((await reader.read()).queue.thread[0].id,'notify');
});
