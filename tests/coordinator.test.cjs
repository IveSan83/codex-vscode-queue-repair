'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const acorn=require('acorn');
const {QueueStore}=require('../queue-store.cjs');
const {QueueProtocolStore}=require('../queue-protocol.cjs');
const {createQueueClient}=require('../queue-client.cjs');
const {expression}=require('../patch.cjs');
const {source,patched,engine,memoryStorage,message,until,wait,json}=require('./coordinator-harness.cjs');

async function durableStorage(t) {
  let legacy={};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-coordinator-test-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const host=new QueueProtocolStore(dir,()=>legacy);
  const client=createQueueClient((method,{params})=>method==='queue-repair-read'?host.read():host.compareAndSet(params),{protocolVersion:2});
  await client.loadQueuedFollowUps();
  return {host,client,storage:{read:client.readQueuedFollowUps,load:client.loadQueuedFollowUps,update:client.updateQueuedFollowUps},staleEvent:()=>{legacy={};}};
}
test('CONTROL: the unmodified shipped coordinator erases its one message on an empty storage refresh',async t=>{
  const storage=memoryStorage();
  const e=engine(false,storage,{ready:false});t.after(e.instance.dispose);
  await e.instance.executionReady;
  e.instance.mutate('thread',()=>[message('lost')]);
  await until(e.quiet);
  assert.equal(e.instance.readMessages('thread').length,1);
  storage.injectEmpty();e.changed();
  await until(e.quiet);
  assert.equal(e.instance.readMessages('thread').length,0);
  assert.equal(e.calls.length,0);
});
test('the actual coordinator + new storage keep the prompt through stale Memento delivery and then send it once',async t=>{
  const {storage,staleEvent}=await durableStorage(t);
  const e=engine(true,storage,{ready:false});t.after(e.instance.dispose);
  await e.instance.executionReady;
  e.instance.mutate('thread',()=>[message('kept')]);
  await until(e.quiet);
  staleEvent();e.changed();await until(e.quiet);
  assert.equal(e.instance.readMessages('thread')[0].id,'kept');
  e.setReady(true);
  await until(()=>e.calls.length===1&&e.quiet());
  assert.deepEqual(e.calls.map(x=>x.id),['kept']);
  assert.equal(e.instance.readMessages('thread').length,0);
  assert.deepEqual(e.errors,[]);
});
test('CONTROL: the original coordinator resends a restored pending message even with a positive receipt',async t=>{
  const storage=memoryStorage();await storage.update(()=>({thread:[message('A')]}));
  const e=engine(false,storage,{accepted:new Set(['A'])});t.after(e.instance.dispose);
  await until(()=>e.calls.length===1&&e.quiet());
  assert.deepEqual(e.calls.map(x=>x.id),['A']);
});
test('positive receipt removes only delivered A before lock acquisition and still executes waiting B',async t=>{
  const {storage}=await durableStorage(t);
  await storage.update(()=>({thread:[message('A'),message('B')]}));
  const e=engine(true,storage,{accepted:new Set(['A'])});t.after(e.instance.dispose);
  await until(()=>e.calls.length===1&&e.quiet());
  assert.deepEqual(e.calls.map(x=>x.id),['B']);
  assert.deepEqual(e.locks,['B']);
  assert.equal(e.instance.readMessages('thread').length,0);
  assert.deepEqual(e.errors,[]);
});
test('a stale follower snapshot cannot delete unseen B or rewind sending A; explicit deletion still works',async t=>{
  const {storage}=await durableStorage(t);
  const a={...message('A'),submission:{hostId:'local',status:'sending'}};
  await storage.update(()=>({thread:[a,message('B')]}));
  const e=engine(true,storage,{ready:false});t.after(e.instance.dispose);
  await e.instance.executionReady;
  await e.instance.acceptFromFollower('thread',[message('A')]);
  assert.deepEqual(json(e.instance.readMessages('thread')).map(m=>m.id),['A','B']);
  assert.equal(e.instance.readMessages('thread')[0].submission.status,'sending');
  await e.instance.acceptFromFollower('thread',[message('A')],['B']);
  assert.deepEqual(json(e.instance.readMessages('thread')).map(m=>m.id),['A']);
  assert.equal(e.calls.length,0);
});
for(const mode of ['queue','steer'])test(`actual submission path: A plus two follow-ups in ${mode} mode, then reload`,async t=>{
  const {storage,client}=await durableStorage(t);
  const e=engine(true,storage,{mode});t.after(e.instance.dispose);
  const unsubscribe=client.subscribeQueuedFollowUps(()=>e.changed());t.after(unsubscribe);
  await e.instance.executionReady;
  await e.send('A');
  await until(e.quiet);
  const b=e.send('B'),c=e.send('C');
  if(mode==='queue') {
    await until(()=>e.instance.readMessages('thread')?.length===2&&e.quiet());
    assert.deepEqual(e.calls.map(x=>x.id),['A']);
    e.complete();
    await until(()=>e.calls.length===2&&e.quiet());
    e.complete();
  }
  await Promise.all([b,c]);
  await until(()=>e.calls.length===3&&e.quiet());
  assert.deepEqual(e.calls.map(x=>x.id),['A','B','C']);
  assert.deepEqual(e.calls.map(x=>x.kind),mode==='queue'?['start','start','start']:['start','steer','steer']);
  assert.deepEqual(e.errors,[]);
  unsubscribe();e.instance.dispose();
  const resumed=engine(true,storage,{accepted:e.accepted});t.after(resumed.instance.dispose);
  await resumed.instance.executionReady;
  await wait(30);
  assert.equal(resumed.calls.length,0);
});
test('all modified shipped bundles remain syntactically valid',()=>{
  for(const [key,code]of Object.entries(patched)) acorn.parse(code,{ecmaVersion:'latest',sourceType:key==='host'?'script':'module',allowReturnOutsideFunction:key==='host'});
});
test('the injected storage adapter is executable and exposes the journal operations',async t=>{
  const {host}=await durableStorage(t);
  const adapter=expression(patched.adapter,'function '+source.profile.adapterFunction+'(').code;
  const factory=vm.runInNewContext(`(${adapter})`,{pm:()=>{},nv:()=>{},console,setInterval,clearInterval,setTimeout,clearTimeout,queueMicrotask});
  const storage=factory({},(method,{params})=>method==='queue-repair-read'?host.read():host.compareAndSet(params));
  await storage.updateQueuedFollowUps(s=>({...s,thread:[message('injected')]}));
  assert.equal((await storage.loadQueuedFollowUps()).thread[0].id,'injected');
});
test('the actual patched extension-host storage class constructs the journal and keeps unrelated settings working',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-host-test-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const cls=expression(patched.host,'XF=class',3).code;
  const XF=vm.runInNewContext(`(${cls})`,{
    require:name=>{assert.equal(name,'./codex-queue-protocol.cjs');return{QueueProtocolStore}},
    QF:{EventEmitter:class {event=()=>({dispose(){}});fire(){};dispose(){}}},
    wX:()=>false,Soe:()=>undefined
  });
  let snapshot={theme:'dark'};
  const state=new XF({get:key=>snapshot[key],update:async(key,value)=>{snapshot[key]=value}},dir);
  t.after(()=>state.dispose());
  await state.update('theme','light');
  assert.equal(await state.get('theme'),'light');
  const initial=await state.queueRepair.read();
  await state.queueRepair.compareAndSet({...initial,protocolVersion:2,queue:{thread:[message('host')]}});
  snapshot={theme:'dark','queued-follow-ups':{}};
  assert.equal((await state.queueRepair.read()).queue.thread[0].id,'host');
});
test('twenty sequential submissions survive storage refreshes and remain exactly once in the transport log',async t=>{
  const {storage,staleEvent}=await durableStorage(t);
  const e=engine(true,storage);t.after(e.instance.dispose);
  for(let i=0;i<20;i++) {
    await e.send('sequential-'+i);
    await until(e.quiet);
    staleEvent();e.changed();await until(e.quiet);
    e.complete();
  }
  await until(e.quiet);
  assert.equal(e.calls.length,20);
  assert.equal(new Set(e.calls.map(c=>c.id)).size,20);
  assert.equal(e.instance.readMessages('thread').length,0);
  assert.deepEqual(e.errors,[]);
});
test('an unconfirmed sending entry survives reload without being automatically resent',async t=>{
  const {storage}=await durableStorage(t);
  await storage.update(()=>({thread:[{...message('unknown'),submission:{hostId:'local',status:'sending'}}]}));
  const e=engine(true,storage);t.after(e.instance.dispose);
  await until(()=>e.instance.readMessages('thread')?.[0]?.submission.status==='outcome-unknown'&&e.quiet());
  assert.equal(e.calls.length,0);
  e.instance.dispose();
  const resumed=engine(true,storage);t.after(resumed.instance.dispose);
  await resumed.instance.executionReady;await wait(30);
  assert.equal(resumed.calls.length,0);
  assert.equal(resumed.instance.readMessages('thread')[0].id,'unknown');
});
test('the response serialization repair preserves false, zero and null and rejects malformed JSON',()=>{
  const before=source.host.match(/bodyJsonString:(JSON\.stringify\(o\))/)[1];
  const after=patched.host.match(/bodyJsonString:(JSON\.stringify\(o\?\?null\))/)[1];
  assert.throws(()=>JSON.parse(vm.runInNewContext(before,{o:undefined})),SyntaxError);
  for(const value of [undefined,null,false,0,'',[],{acquired:false}])
    assert.deepEqual(JSON.parse(vm.runInNewContext(after,{o:value})),value??null);
  assert.throws(()=>JSON.parse('{broken'),SyntaxError);
});
