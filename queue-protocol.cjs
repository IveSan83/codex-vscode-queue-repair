'use strict';
const fs=require('node:fs');
const {QueueStore,validateQueue}=require('./queue-store.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const own=(object,key)=>Object.hasOwn(object,key)?object[key]:undefined;
const generation=message=>message.queueRepairGeneration??0;

function validateRetired(retired) {
  if(!retired||typeof retired!=='object'||Array.isArray(retired))throw new Error('Invalid retired queue records');
  for(const ids of Object.values(retired)) {
    if(!ids||typeof ids!=='object'||Array.isArray(ids))throw new Error('Invalid retired conversation');
    for(const record of Object.values(ids))if(!record||!Number.isSafeInteger(record.generation)||record.generation<0||!Number.isSafeInteger(record.revision)||record.revision<0)throw new Error('Invalid retired message generation');
  }
}
function validateMetadata(records) {
  if(!Array.isArray(records))throw new Error('Invalid queue operation metadata');
  for(const record of records)if(!record||typeof record.conversationId!=='string'||typeof record.id!=='string'||!record.id||!Number.isSafeInteger(record.generation)||record.generation<0)throw new Error('Invalid queue operation generation');
}

// CAS protects the document version. Retirement records additionally protect
// against an old *operation payload* retried against the newest document.
function reconcileProposal(current,request) {
  if(request.protocolVersion!==2)throw new Error('Queue protocol version 2 is required');
  const restores=request.restores??[],removals=request.removals??[];
  validateMetadata(restores);validateMetadata(removals);
  if(current.protocolVersion===2&&!Object.hasOwn(current,'retired'))throw new Error('Missing retired queue records');
  const retired=clone(Object.hasOwn(current,'retired')?current.retired:{});
  validateRetired(retired);
  const queue={};
  for(const thread of new Set([...Object.keys(current.queue),...Object.keys(request.queue)])) {
    const before=own(current.queue,thread)??[];
    const previous=new Map(before.map(message=>[message.id,message]));
    const records=own(retired,thread)??{};
    const after=[];
    for(const incoming of own(request.queue,thread)??[]) {
      if(!Number.isSafeInteger(generation(incoming))||generation(incoming)<0)throw new Error('Invalid queue message generation');
      const existing=previous.get(incoming.id),terminal=own(records,incoming.id);
      const restore=restores.find(r=>r.conversationId===thread&&r.id===incoming.id);
      let message=incoming,number=generation(incoming);
      if(incoming.queueRepairEpoch!=null&&incoming.queueRepairEpoch!==current.epoch){if(existing)after.push(existing);continue;}
      if(existing) {
        // Old snapshots from before Undo cannot overwrite the restored entry.
        if(generation(incoming)!==generation(existing))message=existing;
        number=generation(existing);
      } else if(terminal) {
        if(!restore)continue;
        if(restore.generation!==terminal.generation||generation(incoming)!==terminal.generation)throw new Error('Queue restore conflicts with a newer removal');
        number=terminal.generation+1;
        if(!Number.isSafeInteger(number))throw new Error('Queue generation exhausted');
      } else if(number!==0)throw new Error('Unknown restored queue generation');
      after.push({...message,queueRepairEpoch:current.epoch,queueRepairGeneration:number});
    }
    const retained=new Set(after.map(message=>message.id));
    for(const message of before) {
      if(retained.has(message.id))continue;
      const removal=removals.find(r=>r.conversationId===thread&&r.id===message.id);
      if(!removal||removal.generation!==generation(message)) {
        // A delayed delete from before Undo must not delete its new generation.
        after.push(message);continue;
      }
      Object.defineProperty(records,message.id,{value:{generation:generation(message),revision:current.revision+1},enumerable:true,configurable:true,writable:true});
    }
    if(Object.keys(records).length)Object.defineProperty(retired,thread,{value:records,enumerable:true,configurable:true,writable:true});
    if(after.length)Object.defineProperty(queue,thread,{value:after,enumerable:true,configurable:true,writable:true});
  }
  validateQueue(queue);
  return {...current,protocolVersion:2,revision:current.revision+1,queue,retired};
}

class QueueProtocolStore extends QueueStore {
  constructor(directory,readLegacy,options={}) {
    super(directory,readLegacy,{...options,reconcileProposal});
    this.onHint=options.onHint;
    this.onHintError=options.onHintError??(()=>{});
    this.watcher=undefined;
    this.hintFlight=undefined;
    this.hintAgain=false;
    this.lastHint=undefined;
    this.disposed=false;
  }
  async readExisting() {
    const document=await super.readExisting();
    if(document.protocolVersion!=null&&document.protocolVersion!==2)throw new Error('Unsupported queue operation protocol');
    if(document.protocolVersion===2&&!Object.hasOwn(document,'retired'))throw new Error('Missing retired queue records');
    validateRetired(Object.hasOwn(document,'retired')?document.retired:{});
    if(document.protocolVersion===2)for(const messages of Object.values(document.queue))for(const message of messages)if(message.queueRepairEpoch!==document.epoch||!Number.isSafeInteger(message.queueRepairGeneration)||message.queueRepairGeneration<0)throw new Error('Invalid canonical queue message generation');
    if(document.protocolVersion==null&&Object.hasOwn(document,'retired'))throw new Error('Missing queue operation protocol');
    return document;
  }
  emitHint(document) {
    if(this.disposed||!this.onHint)return;
    const key=document.epoch+':'+document.revision;
    if(this.lastHint===key)return;
    this.lastHint=key;
    try{this.onHint({epoch:document.epoch,revision:document.revision,queue:document.queue})}catch(error){this.reportHintError(error)}
  }
  reportHintError(error){try{this.onHintError(error)}catch{}}
  async writeDocument(document) {
    await super.writeDocument(document);
    this.emitHint(document);
  }
  startWatcher() {
    if(this.disposed||this.watcher||!this.onHint)return;
    try {
      this.watcher=fs.watch(this.directory,(_event,filename)=>{
        if(filename!=null&&String(filename)!=='queue.json')return;
        this.hintAgain=true;
        if(this.hintFlight)return;
        this.hintFlight=(async()=>{do{this.hintAgain=false;this.emitHint(await this.readExisting())}while(this.hintAgain&&!this.disposed)})().catch(error=>this.reportHintError(error)).finally(()=>{this.hintFlight=undefined});
      });
      this.watcher.unref();
      this.watcher.on('error',error=>{this.watcher?.close();this.watcher=undefined;this.reportHintError(error)});
    }catch(error){this.reportHintError(error)}
  }
  async read() {
    let document;
    try{document=await this.readExisting()}catch(error){if(error.code!=='ENOENT'||this.initialized)throw error}
    if(document?.protocolVersion!==2) {
      document=await this.transaction(async()=>{
        const current=await this.readDocument();
        if(current.protocolVersion===2)return current;
        const queue=Object.fromEntries(Object.entries(current.queue).map(([thread,messages])=>[thread,messages.map(message=>({...message,queueRepairEpoch:current.epoch,queueRepairGeneration:0}))]));
        const next={...current,protocolVersion:2,revision:current.revision+1,queue,retired:{}};
        await this.writeDocument(next);
        return next;
      });
    }
    this.startWatcher();return{epoch:document.epoch,revision:document.revision,queue:document.queue};
  }
  dispose(){this.disposed=true;this.watcher?.close();this.watcher=undefined}
}

module.exports={QueueProtocolStore,reconcileProposal,validateRetired};
