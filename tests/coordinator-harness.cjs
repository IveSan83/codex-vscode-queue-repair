'use strict';
const vm=require('node:vm');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const {readOriginal,patchSources,expression}=require('../patch.cjs');
const source=readOriginal(process.env.CODEX_QUEUE_TEST_EXTENSION || path.resolve(__dirname,'../artifacts/base/extension'));
const patched=patchSources(source);
const json=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label='condition') {
  const deadline=Date.now()+3000;
  while(!predicate() && Date.now()<deadline)await wait(5);
  if(!predicate())throw new Error('Timeout: '+label);
}
function queueClass(fixed) {
  const code=(fixed?patched:source).coordinator;
  const prepare=expression(code,'function '+source.profile.prepareFunction+'(').code;
  const cls=expression(code,source.profile.coordinatorClass+'=class',source.profile.coordinatorClass.length+1).code;
  const sandbox={
    console,Promise,Map,Set,Error,Symbol,queueMicrotask,setTimeout,clearTimeout,
    zq:class{}, PQ:[], TAn:'submission-outcome-unknown',
    MQ:class extends Error{}, Ce:class extends Error{}, le:class extends Error{}, M:class extends Error{},
    z:x=>x, se:()=>false,
    wAn:{default:json}, NQ:{default:(a,b)=>isDeepStrictEqual(json(a),json(b))},
    ft:()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}},
    tX:class {constructor(fn){this.fn=fn}dispose(){this.fn()}[Symbol.dispose](){this.fn()}},
    Lt:()=>({items:[],u(x){this.items.push(x);return x},d(){for(const x of this.items.reverse())x.dispose();if(this.e)throw this.e}})
  };
  const aliases=Object.fromEntries(Object.entries(source.profile.sandboxAliases).map(([name,previous])=>[name,sandbox[previous]]));
  Object.assign(sandbox,aliases);
  return vm.runInNewContext(`${prepare};(${cls})`,sandbox,{timeout:2000});
}
function memoryStorage() {
  let state={};
  return {
    read:()=>({isLoading:false,value:state}),
    load:async()=>json(state),
    update:async(fn)=>{state=json(fn(json(state)));return json(state);},
    injectEmpty:()=>{state={};}
  };
}
function engine(fixed,storage,{mode='queue',accepted=new Set(),ready=true,coordination,requestFollower,initialRole='owner',ownerClientId='owner'}={}) {
  let callbacks,started=false,active=null,number=0,role=initialRole;
  const calls=[],errors=[],locks=[];
  const execution={
    subscribe:fn=>{callbacks=fn;return()=>{}},
    isClientReady:()=>ready, canAcquireOwnership:()=>true,
    tryAcquireStartTurn:()=>{if(started)return false;started=true;return true},
    releaseStartTurn:()=>{started=false},
    acquireSendLock:async(thread,id)=>{locks.push(id);return{release:async()=>{}}},
    prepare:async(thread,message)=>({status:'ready',submission:prepared(thread,message)}),
    errorReason:error=>error.message
  };
  function prepared(thread,message) {
    return {conversationId:thread,resume:{conversationId:thread},start:{message},steer:{message}};
  }
  async function submit(kind,thread,request,onAdded,onSending,admission) {
    await admission?.();await onSending?.();
    const id=request.message.id;
    calls.push({kind,id,turn:kind==='start'?++number:active});
    active=number;accepted.add(id);
    onAdded?.({});
    return 'turn-'+number;
  }
  const instance=new(queueClass(fixed))({
    hostId:'local', isDurableThread:()=>false,
    getMessageQueueMode:async()=>mode,
    createMessageThreadId:()=>undefined,
    wasMessageAccepted:(_thread,id)=>accepted.has(id),
    getStreamRole:()=>({role,ownerClientId}),
    coordination,requestFollower,
    canSend:()=>active===null,
    requiresReplayAdmission:false,
    execution:()=>execution,
    storage,
    logger:{warning:(message,data)=>errors.push({message,error:data.sensitive?.error?.message}),error:(...args)=>errors.push(args)},
    submissionHost:{
      needsResume:()=>false,resume:async()=>({status:'ready',activeTurnId:null}),
      getActiveTurnId:()=>active===null?null:'turn-'+active,
      hasPendingTurnStart:()=>false,hasFinalAnswer:()=>false,
      start:(...args)=>submit('start',...args),steer:(...args)=>submit('steer',...args),
      canStartAfterSteerError:()=>false
    }
  });
  return {
    instance,calls,errors,locks,accepted,
    changed:()=>callbacks.changed(),
    setReady:value=>{ready=value;callbacks.readinessChanged('thread')},
    setFollower:()=>{role='follower'},
    complete:()=>{active=null;callbacks.turnCompleted({conversationId:'thread',status:'completed'});callbacks.readinessChanged('thread')},
    interrupt:()=>{active=null;callbacks.turnCompleted({conversationId:'thread',status:'interrupted'});callbacks.readinessChanged('thread')},
    send:(id,text=id)=>instance.sendMessage({conversationId:'thread',message:{...message(id),text},acceptLocally:true},async(request)=>prepared(request.conversationId,request.message)),
    quiet:()=>!instance.pending.size && !instance.running.size && !instance.queueRefresh,
  };
}
function message(id) {return{id,text:id,context:{},submission:{hostId:'local',status:'pending'}};}
module.exports={source,patched,queueClass,memoryStorage,engine,message,wait,until,json};
