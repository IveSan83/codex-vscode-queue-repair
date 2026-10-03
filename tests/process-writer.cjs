'use strict';
const {QueueStore}=require('../queue-store.cjs');
const {createQueueClient}=require('../queue-client.cjs');
(async()=>{
  const host=new QueueStore(process.argv[2]);
  const client=createQueueClient((method,{params})=>method==='queue-repair-read'?host.read():host.compareAndSet(params));
  for(let i=0;i<12;i++) {
    const id=process.argv[3]+'-'+i;
    await client.updateQueuedFollowUps(s=>({...s,thread:[...(s.thread??[]),{id,context:{}}]}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
