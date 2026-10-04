'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const acorn=require('acorn');
const {createQueueClient}=require('./queue-client.cjs');
const releases=require('./releases.json');
const latestVersion='26.930.51102';
const files=releases[latestVersion].files,hashes=releases[latestVersion].hashes;
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
function once(text,before,after){if(text.split(before).length!==2)throw new Error('Patch anchor is not unique: '+before.slice(0,100));return text.replace(before,()=>after)}
function expression(text,anchor,offset=0){const start=text.indexOf(anchor)+offset;if(start<offset)throw new Error('Missing '+anchor);const node=acorn.parseExpressionAt(text,start,{ecmaVersion:'latest',sourceType:'module'});return{start,end:node.end,code:text.slice(start,node.end)}}
function walk(node,predicate,out=[]){if(!node||typeof node!=='object')return out;if(node.type&&predicate(node))out.push(node);for(const value of Object.values(node)){if(Array.isArray(value))for(const item of value)walk(item,predicate,out);else if(value&&typeof value==='object')walk(value,predicate,out)}return out}
function classAst(code){return acorn.parseExpressionAt(code,0,{ecmaVersion:'latest',sourceType:'module'})}
function appendPrivateCall(code,methodName,argumentsText){const method=classAst(code).body.body.find(m=>m.key.name===methodName);if(!method)throw Error('Missing method '+methodName);const calls=walk(method,n=>n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.property.type==='PrivateIdentifier'&&n.callee.property.name==='_');if(calls.length!==1)throw Error('Ambiguous private mutation call');const c=calls[0];return code.slice(0,c.end-1)+argumentsText+code.slice(c.end-1)}
function patchSources(input){
 const profile=input.profile??{...releases[latestVersion],version:latestVersion};
 let host=input.host;
 const hostClass=profile.hostClass??'XF';
 host=once(host,hostClass+'=class{constructor(e){this.storage=e}', hostClass+'=class{constructor(e,r){this.storage=e;this.queueRepair=new(require("./codex-queue-protocol.cjs").QueueProtocolStore)(r,()=>e.get("queued-follow-ups")??{},{onHint:s=>this.onDidUpdateEntryEmitter.fire({key:"queued-follow-ups",value:s.queue}),onHintError:e=>console.warn("Codex queue notification failed:",e.message)})}');
 host=once(host,'new '+hostClass+'(t.globalState)','new '+hostClass+'(t.globalState,t.globalStorageUri.fsPath)');
 host=once(host,'"get-global-state":async({key:e})=>{','"queue-repair-read":async()=>this.globalState.queueRepair.read(),"queue-repair-cas":async(e)=>this.globalState.queueRepair.compareAndSet(e),"get-global-state":async({key:e})=>{');
 host=once(host,'bodyJsonString:JSON.stringify(o)','bodyJsonString:JSON.stringify(o??null)');
 host=once(host,'dispose(){this.onDidUpdateEntryEmitter.dispose()','dispose(){this.queueRepair.dispose();this.onDidUpdateEntryEmitter.dispose()');
 const adapterFunction=expression(input.adapter,'function '+profile.adapterFunction+'(');
 const marker=adapterFunction.code.indexOf(',readQueuedFollowUps()');if(marker<0)throw Error('Missing queue adapter');
 const adapterAst=acorn.parseExpressionAt(adapterFunction.code,0,{ecmaVersion:'latest'});
 const object=adapterAst.body.body.find(n=>n.type==='ReturnStatement').argument;
 const subscription=object.properties.find(p=>p.key.name==='subscribeQueuedFollowUps').value;
 const subscribeCode=adapterFunction.code.slice(subscription.start,subscription.end);
 const adapterCode=adapterFunction.code.slice(0,marker)+`,...(${createQueueClient.toString()})(t,{protocolVersion:2,subscribeHints:e!=null&&typeof e.watch==="function"?(${subscribeCode}):undefined,onError:error=>console.warn("Codex queue journal read failed:",error.message)})}}`;
 const adapter=input.adapter.slice(0,adapterFunction.start)+adapterCode+input.adapter.slice(adapterFunction.end);
 let coordinator=input.coordinator;
 const cls=expression(coordinator,profile.coordinatorClass+'=class',profile.coordinatorClass.length+1);
 let code=cls.code;
 code=once(code,'options;messages=new Map;','options;readLocalMessages=e=>this.#p(e)??'+profile.emptyQueue+';messages=new Map;');
 const receipt='if(r!=null&&u()&&this.options.wasMessageAccepted(e,r.id)){await this.#_(e,t=>t.filter(t=>t.id!==r.id),u);this.accepted.get(e)?.get(r.id)?.result.resolve({status:`sent`,messageId:r.id});this.#f(e,r.id);return}';
 code=once(code,'if(!d()||r==null||!t.tryAcquireStartTurn(e)',receipt+'if(!d()||r==null||!t.tryAcquireStartTurn(e)');
 code=once(code,'if(r.submission?.status===`sending`||r.submission?.status===`outcome-unknown`)',receipt+'if(r.submission?.status===`sending`||r.submission?.status===`outcome-unknown`)');
 // A successful no-op CAS is not proof that this sender claimed pending->sending.
 // Check the final pre-mutation entry before adopting our proposed status.
 const eq=profile.claimEqual??'MQ',claimError=profile.claimError??'jQ';
 const claimTail='if(await this.#_(e,e=>e.map(e=>(0,'+eq+'.default)(e,n)?i:e),u,!1),r=i,';
 code=once(code,claimTail,'let queueRepairBefore=await this.#_(e,e=>e.map(e=>(0,'+eq+'.default)(e,n)?i:e),u,!1);if(!(0,'+eq+'.default)(queueRepairBefore.find(message=>message.id===n.id),n))throw new '+claimError+';if(r=i,');
 code=once(code,'let r=new Map(e.filter(e=>e.submission?.status===`outcome-unknown`&&!n.includes(e.id)).map(e=>[e.id,e]));return[...t.map(e=>r.get(e.id)??e),...[...r.values()].filter(e=>!t.some(({id:t})=>t===e.id))]','let r=new Map(e.filter(e=>!n.includes(e.id)).map(e=>[e.id,e]));return[...t.filter(e=>!n.includes(e.id)).map(e=>{let t=r.get(e.id);return t?.submission?.status===`sending`||t?.submission?.status===`outcome-unknown`?t:e}),...[...r.values()].filter(e=>!t.some(({id:t})=>t===e.id))]');
 const removeMethod=classAst(code).body.body.find(m=>m.key.name==='removeQueuedMessage');
 const removeReturn=removeMethod.value.body.body.at(-1);
 if(removeReturn.type!=='ReturnStatement')throw Error('Unexpected remove method');
 code=code.slice(0,removeReturn.start)+'if(this.#p(e)?.some(message=>message.id===t))return null;'+code.slice(removeReturn.start);
 const clearMethod=classAst(code).body.body.find(m=>m.key.name==='clearQueuedMessages');
 const clearCandidates=walk(clearMethod,n=>n.type==='VariableDeclarator'&&n.id.name==='a'&&n.init?.type==='CallExpression'&&code.slice(n.init.callee.start,n.init.callee.end)==='r.filter');
 if(clearCandidates.length!==1)throw Error('Unexpected clear method');
 const clearInit=clearCandidates[0].init;
 code=code.slice(0,clearInit.end)+'.filter(message=>!this.#p(e)?.some(current=>current.id===message.id))'+code.slice(clearInit.end);
 code=appendPrivateCall(code,'restoreQueuedMessage',',!0,[],[{conversationId:e,id:t.message.id,generation:t.message.queueRepairGeneration??0}]');
 code=once(code,'acceptFromFollower=async(e,t,n=[])=>','acceptFromFollower=async(e,t,n=[],queueRepairRestores=[],queueRepairRemovals)=>');
 code=appendPrivateCall(code,'acceptFromFollower',',queueRepairRestores,queueRepairRemovals');
 code=once(code,'async#_(e,t,n,r=!0,i=[])','async#_(e,t,n,r=!0,i=[],queueRepairRestores=[],queueRepairRemovals)');
 code=once(code,'let o=t(a),s=this.pending.get(e)', 'let o=t(a),queueRepairDeleteMetadata=queueRepairRemovals??Array.from(new Set([...i,...a.filter(message=>!o.some(next=>next.id===message.id)).map(message=>message.id)])).map(id=>({conversationId:e,id,generation:a.find(message=>message.id===id)?.queueRepairGeneration??0})),s=this.pending.get(e)');
 code=once(code,'this.options.requestFollower(e,{[e]:o},c.ownerClientId,i)','this.options.requestFollower(e,{[e]:o},c.ownerClientId,i,queueRepairRestores,queueRepairDeleteMetadata)');
 code=once(code,'if(t.resultType===`error`)throw Error(t.error)','if(t.resultType===`error`)throw Error(t.error);if(!Array.isArray(t.result?.messages))throw Error(`Queue owner did not confirm canonical state; reload all windows`);o=t.result.messages');
 const mutation=classAst(code).body.body.find(n=>n.key.type==='PrivateIdentifier'&&n.key.name==='_');
 const awaitUpdates=walk(mutation,n=>n.type==='AwaitExpression'&&n.argument.type==='CallExpression'&&code.slice(n.argument.callee.start,n.argument.callee.end)==='this.options.storage.update');
 if(awaitUpdates.length!==1)throw Error('Ambiguous durable queue mutation');
 const awaiting=awaitUpdates[0],call=awaiting.argument;
 const updateCode=code.slice(call.start,call.end-1)+',{restores:queueRepairRestores,removals:queueRepairDeleteMetadata})';
 code=code.slice(0,awaiting.start)+'(o=(await '+updateCode+')[e]??'+profile.emptyQueue+')'+code.slice(awaiting.end);
 coordinator=coordinator.slice(0,cls.start)+code+coordinator.slice(cls.end);
 coordinator=once(coordinator,'t.params.state[t.params.conversationId]??[],t.params.discardedMessageIds)','t.params.state[t.params.conversationId]??[],t.params.discardedMessageIds,t.params.restores??[],t.params.removals)');
 coordinator=once(coordinator,'t.params.discardedMessageIds,t.params.restores??[],t.params.removals),{method:t.method,result:{ok:!0}}','t.params.discardedMessageIds,t.params.restores??[],t.params.removals),{method:t.method,result:{ok:!0,messages:e.turnCoordinator.readLocalMessages(t.params.conversationId)}}');
 coordinator=once(coordinator,'requestFollower:async(e,t,r,i)=>n==null?','requestFollower:async(e,t,r,i,restores,removals)=>n==null?');
 coordinator=once(coordinator,'{conversationId:e,state:t,discardedMessageIds:i},{targetClientId:r})','{conversationId:e,state:t,discardedMessageIds:i,restores,removals},{targetClientId:r})');
 coordinator=once(coordinator,'update:e=>i.updateQueuedFollowUps?.(e)??','update:(e,t)=>i.updateQueuedFollowUps?.(e,t)??');
 return{host,adapter,coordinator};
}
function readOriginal(directory){
 const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
 const profile=releases[pkg.version];
 if(pkg.publisher!=='openai'||pkg.name!=='chatgpt'||!profile)throw Error('Unsupported original Codex extension release');
 const input={};
 for(const[key,rel]of Object.entries(profile.files)){const data=fs.readFileSync(path.join(directory,rel));if(sha(data)!==profile.hashes[key])throw Error('Unrecognized original bundle '+rel);input[key]=data.toString('utf8')}
 Object.defineProperty(input,'profile',{value:{...profile,version:pkg.version}});
 return input;
}
function apply(directory){
 const input=readOriginal(directory),output=patchSources(input),profile=input.profile;
 for(const[key,code]of Object.entries(output))acorn.parse(code,{ecmaVersion:'latest',sourceType:key==='host'?'script':'module',allowReturnOutsideFunction:key==='host'});
 const backup=path.join(directory,'queue-repair-backup');fs.mkdirSync(backup);
 for(const[key,rel]of Object.entries(profile.files))fs.copyFileSync(path.join(directory,rel),path.join(backup,key+'.js'));
 // Keep the store basename: the protocol module requires ./queue-store.cjs.
 const helpers={'out/queue-store.cjs':'queue-store.cjs','out/codex-queue-protocol.cjs':'queue-protocol.cjs'};
 const manifest={patchVersion:'2.3',extensionVersion:profile.version,files:{},helpers:{}};
 try{
  for(const[rel,source]of Object.entries(helpers)){fs.copyFileSync(path.join(__dirname,source),path.join(directory,rel));manifest.helpers[rel]=sha(fs.readFileSync(path.join(directory,rel)))}
  for(const[key,rel]of Object.entries(profile.files)){fs.writeFileSync(path.join(directory,rel),output[key]);manifest.files[rel]={original:profile.hashes[key],patched:sha(Buffer.from(output[key]))}}
  fs.writeFileSync(path.join(directory,'queue-repair-manifest.json'),JSON.stringify(manifest,null,2));
 }catch(error){for(const[key,rel]of Object.entries(profile.files))fs.copyFileSync(path.join(backup,key+'.js'),path.join(directory,rel));for(const rel of Object.keys(helpers))fs.rmSync(path.join(directory,rel),{force:true});throw error}
 return manifest;
}
module.exports={files,hashes,sha,once,expression,patchSources,readOriginal,apply,latestVersion};
if(require.main===module){if(!process.argv[2])throw Error('Usage: node patch.cjs ABSOLUTE_EXTENSION_DIRECTORY');console.log(JSON.stringify(apply(path.resolve(process.argv[2])),null,2))}
