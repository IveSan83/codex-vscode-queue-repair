'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {engine,memoryStorage,until}=require('./coordinator-harness.cjs');

function serverQueue(initial=[]){
 let entries=initial,listener,disposed=0;
 const removed=[];
 return {removed,get disposed(){return disposed},
  subscribe(fn){listener=fn;return()=>{listener=undefined}},
  dispose(){disposed++},isEnabled:()=>true,
  read:()=>entries,load:async()=>entries,
  remove:async(_thread,id)=>{const item=entries.find(x=>x.id===id);entries=entries.filter(x=>x.id!==id);return item??null},
  findByClientMessageId:(_thread,id)=>entries.find(x=>x.clientUserMessageId===id),
  changed(next){entries=next;listener?.('thread')}
 };
}
test('51102 compatibility: patched coordinator retires a server receipt only after durable server removal',async t=>{
 const e=engine(true,memoryStorage(),{ready:false});t.after(e.instance.dispose);
 const q=serverQueue([{id:'server-a',clientUserMessageId:'a'}]),events=[];
 let receipts=[{serverQueuedMessageId:'server-a',clientUserMessageId:'a'}];
 e.instance.options.readUnconfirmedServerQueueMessages=()=>receipts;
 e.instance.options.onUnconfirmedSubmissionDiscarded=(_thread,id)=>{events.push(id);receipts=[]};
 e.instance.setServerQueue(q);
 e.instance.reconcileServerQueueReceipts('thread',receipts);
 await until(()=>events.length===1);
 assert.deepEqual(q.read(),[]);assert.deepEqual(events,['a']);assert.equal(e.calls.length,0);
});
test('51102 compatibility: follower cannot remove the owner server queue receipt',async t=>{
 const e=engine(true,memoryStorage(),{ready:false,initialRole:'follower'});t.after(e.instance.dispose);
 const q=serverQueue([{id:'server-a',clientUserMessageId:'a'}]);e.instance.setServerQueue(q);
 e.instance.reconcileServerQueueReceipts('thread',[{serverQueuedMessageId:'server-a',clientUserMessageId:'a'}]);
 await Promise.resolve();assert.equal(q.read().length,1);assert.equal(e.instance.reconcilingServerQueues.size,0);
});
test('51102 compatibility: replacing the app-server queue detaches and disposes its previous subscription',async t=>{
 const e=engine(true,memoryStorage(),{ready:false});t.after(e.instance.dispose);
 const first=serverQueue(),second=serverQueue(),events=[];
 e.instance.options.onQueueChanged=id=>events.push(id);
 e.instance.setServerQueue(first);e.instance.setServerQueue(second);
 assert.equal(first.disposed,1);first.changed([]);assert.deepEqual(events,[]);
 second.changed([]);assert.deepEqual(events,['thread']);
});
