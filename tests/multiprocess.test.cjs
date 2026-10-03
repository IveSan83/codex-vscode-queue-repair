'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {QueueStore}=require('../queue-store.cjs');
test('four independent host processes append 48 messages without lost updates',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-multiprocess-'));
  t.after(()=>fs.rm(dir,{force:true,recursive:true}));
  const reader=new QueueStore(dir);await reader.read();
  let running=true;
  const readLoop=(async()=>{while(running){await reader.read();await new Promise(r=>setTimeout(r,1));}})();
  try {
    await Promise.all(Array.from({length:4},(_,i)=>promisify(execFile)(process.execPath,[path.join(__dirname,'process-writer.cjs'),dir,String(i)],{windowsHide:true})));
  } finally {running=false;await readLoop;}
  const items=(await reader.read()).queue.thread;
  assert.equal(items.length,48);
  assert.equal(new Set(items.map(m=>m.id)).size,48);
});
