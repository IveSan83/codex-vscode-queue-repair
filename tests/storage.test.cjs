'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {QueueStore} = require('../queue-store.cjs');
const {createQueueClient} = require('../queue-client.cjs');
const message = id => ({id, text:id, context:{}, submission:{hostId:'local',status:'pending'}});
async function fixture(t,legacy=()=>({})) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-queue-unit-'));
  // Only this unique test directory is removed.
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const host=new QueueStore(dir,legacy);
  const fetch=(method,{params})=>method==='queue-repair-read'?host.read():host.compareAndSet(params);
  return {dir,host,fetch,client:createQueueClient(fetch)};
}
test('a delayed empty Memento snapshot and an unrelated settings write cannot erase a committed prompt',async t=>{
  let memento={};
  const {host,client}=await fixture(t,()=>memento['queued-follow-ups']);
  await client.updateQueuedFollowUps(s=>({...s,thread:[message('A')]}));
  memento={'queued-follow-ups':{}};
  memento['persisted-atom-state']={theme:'dark'};
  assert.equal((await client.loadQueuedFollowUps()).thread[0].id,'A');
  const restarted=new QueueStore(path.dirname(host.directory),()=>memento['queued-follow-ups']);
  assert.equal((await restarted.read()).queue.thread[0].id,'A');
});
test('two clients starting from the same revision retry only the storage mutation, preserving both threads',async t=>{
  const {fetch,host}=await fixture(t);
  let reads=0,release;
  const barrier=new Promise(r=>release=r);
  const together=async(method,args)=>{
    const result=await fetch(method,args);
    if(method==='queue-repair-read' && ++reads<=2){if(reads===2)release();await barrier;}
    return result;
  };
  const a=createQueueClient(together),b=createQueueClient(together);
  await Promise.all([
    a.updateQueuedFollowUps(s=>({...s,first:[message('A')]})),
    b.updateQueuedFollowUps(s=>({...s,second:[message('B')]}))
  ]);
  assert.deepEqual(Object.keys((await host.read()).queue).sort(),['first','second']);
});
test('concurrent appends to the same thread preserve all message IDs',async t=>{
  const {fetch,host}=await fixture(t);
  const clients=Array.from({length:8},()=>createQueueClient(fetch));
  await Promise.all(clients.map((c,i)=>c.updateQueuedFollowUps(s=>({...s,thread:[...(s.thread??[]),message(String(i))]}))));
  const queue=(await host.read()).queue.thread;
  assert.equal(queue.length,8);
  assert.equal(new Set(queue.map(m=>m.id)).size,8);
});
test('a stale snapshot cannot resurrect a deleted delivered entry',async t=>{
  const {host,client}=await fixture(t);
  await client.updateQueuedFollowUps(s=>({...s,thread:[message('A')]}));
  const old=await host.read();
  await client.updateQueuedFollowUps(()=>({}));
  assert.deepEqual(await host.compareAndSet(old),{applied:false});
  assert.deepEqual((await host.read()).queue,{});
});
test('read errors and corrupt JSON are rejected, never converted into empty queues',async t=>{
  const {host,client}=await fixture(t);
  await client.updateQueuedFollowUps(s=>({...s,thread:[message('A')]}));
  await fs.writeFile(host.file,'{broken');
  await assert.rejects(client.loadQueuedFollowUps(),SyntaxError);
  assert.equal(client.readQueuedFollowUps().value.thread[0].id,'A');
});
test('legacy messages are backed up and paused; migration never silently replays them',async t=>{
  const original={thread:[message('old')]};
  const {host}=await fixture(t,()=>original);
  const migrated=(await host.read()).queue.thread[0];
  assert.equal(migrated.submission.status,'queued');
  assert.match(migrated.pausedReason,/Recovered/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(host.directory,'legacy-snapshot.json'),'utf8')),original);
});
test('a held or abandoned lock fails with an error without overwriting state',async t=>{
  const {host,client}=await fixture(t);
  await client.updateQueuedFollowUps(s=>({...s,thread:[message('A')]}));
  await fs.writeFile(host.lock,'{"pid":0}');
  const other=new QueueStore(path.dirname(host.directory),()=>({}),{timeoutMs:50});
  const snapshot=await other.read();
  await assert.rejects(other.compareAndSet({...snapshot,queue:{}}),/locked/);
  assert.equal(JSON.parse(await fs.readFile(host.file,'utf8')).queue.thread[0].id,'A');
});
test('subscribed clients observe another window and stop polling on disposal',async t=>{
  const {fetch,client}=await fixture(t);
  const follower=createQueueClient(fetch,{pollMs:10});
  let changes=0;
  const stop=follower.subscribeQueuedFollowUps(()=>changes++);
  t.after(stop);
  await follower.loadQueuedFollowUps();
  await client.updateQueuedFollowUps(s=>({...s,thread:[message('A')]}));
  const until=Date.now()+1000;
  while(!follower.readQueuedFollowUps().value?.thread && Date.now()<until)await new Promise(r=>setTimeout(r,10));
  assert.equal(follower.readQueuedFollowUps().value.thread[0].id,'A');
  stop();
  const before=changes;
  await client.updateQueuedFollowUps(()=>({}));
  await new Promise(r=>setTimeout(r,30));
  assert.equal(changes,before);
});
