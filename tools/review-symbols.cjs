'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),acorn=require('acorn');
const {expression}=require('../patch.cjs');
const root=path.resolve(__dirname,'..'),old=require('../releases.json')['26.930.31428'];
const bundle=JSON.parse(fs.readFileSync(path.join(root,'artifacts/new-bundles.json')));
const oldRoot=path.join(root,'artifacts/old-original/extension'),newRoot=path.join(root,'artifacts/new-original/extension');
const read=(base,file)=>fs.readFileSync(path.join(base,file),'utf8');
const files={host:'out/extension.js',adapter:bundle.roles.adapter.replace('extension/',''),coordinator:bundle.roles.coordinator.replace('extension/','')};
const before=Object.fromEntries(Object.entries(old.files).map(([k,f])=>[k,read(oldRoot,f)]));
const after=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,read(newRoot,f)]));
const hostName=/([\w$]+)=class\{constructor\(e\)\{this.storage=e\}/.exec(after.host)[1];
const coordinatorName=/([\w$]+)=class extends [\w$]+\{options;messages=new Map;/.exec(after.coordinator)[1];
const prepareName=/function ([\w$]+)\(\{host:e,isActive:t,isDurableThread:n,getQueueMode:r,enqueue:i\}\)/.exec(after.coordinator)[1];
const adapterOffset=after.adapter.indexOf(',readQueuedFollowUps(){');
const adapterName=/function ([\w$]+)\(/.exec(after.adapter.slice(after.adapter.lastIndexOf('function ',adapterOffset)))[1];
const candidates={
 host:[expression(before.host,'XF=class',3).code,expression(after.host,hostName+'=class',hostName.length+1).code],
 adapter:[expression(before.adapter,'function '+old.adapterFunction+'(').code,expression(after.adapter,'function '+adapterName+'(').code],
 coordinator:[expression(before.coordinator,old.coordinatorClass+'=class',old.coordinatorClass.length+1).code,expression(after.coordinator,coordinatorName+'=class',coordinatorName.length+1).code],
 prepare:[expression(before.coordinator,'function '+old.prepareFunction+'(').code,expression(after.coordinator,'function '+prepareName+'(').code]
};
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const tokenize=s=>[...acorn.tokenizer(s,{ecmaVersion:'latest',sourceType:'module'})];
function normalized(tokens,code){
 const keys=new Set();
 const walk=node=>{if(!node||typeof node!=='object')return;
  if(['Property','PropertyDefinition','MethodDefinition'].includes(node.type)&&!node.computed&&node.key)keys.add(node.key.start);
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);
 };walk(acorn.parseExpressionAt(code,0,{ecmaVersion:'latest',sourceType:'module'}));
 return tokens.map((t,i)=>{
 const label=t.type.label,prev=tokens[i-1]?.type.label;
 const value=label==='name'&&!['.','?.'].includes(prev)&&!keys.has(t.start)?'$ID':t.value;
 return label+':'+JSON.stringify(value??'');
}).join('\n');}
const result={hostName,coordinatorName,prepareName,adapterName,parts:{},maps:{}};
for(const [key,[a,b]] of Object.entries(candidates)){
 const ta=tokenize(a),tb=tokenize(b),equal=normalized(ta,a)===normalized(tb,b),map={};
 if(equal)for(let i=0;i<ta.length;i++)if(ta[i].type.label==='name'&&ta[i].value!==tb[i].value){
  const x=ta[i].value,y=tb[i].value;if(map[x]&&map[x]!==y)throw Error('Ambiguous symbol mapping '+key+' '+x);map[x]=y;
 }
 result.parts[key]={oldBytes:Buffer.byteLength(a),newBytes:Buffer.byteLength(b),oldSha:digest(a),newSha:digest(b),sameAfterIdentifierNormalization:equal};
 result.maps[key]=map;
 fs.writeFileSync(path.join(root,'artifacts',key+'-old.js'),a);
 fs.writeFileSync(path.join(root,'artifacts',key+'-new.js'),b);
}
fs.writeFileSync(path.join(root,'artifacts/critical-component-comparison.json'),JSON.stringify(result,null,2));
if(!Object.values(result.parts).every(p=>p.sameAfterIdentifierNormalization)){
 console.log(JSON.stringify(result,null,2));
 throw Error('Critical component changed structurally; inspect artifacts before adapting tests');
}
const mappings={...result.maps.coordinator,...result.maps.prepare};
const profile={...old,vsixSha256:'de39fdeeb6707d55a5f797426d4871adcf8a1e5d3d7d2d128957b43e88c2576b',
 downloadUrl:'https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.930.31730/1790996661385/Microsoft.VisualStudio.Services.VSIXPackage',
 files,hashes:Object.fromEntries(Object.entries(files).map(([k,f])=>[k,digest(read(newRoot,f))])),
 coordinatorClass:coordinatorName,prepareFunction:prepareName,adapterFunction:adapterName,
 sandboxAliases:Object.fromEntries(Object.entries(old.sandboxAliases).map(([k,v])=>[mappings[k]??k,v]))};
fs.writeFileSync(path.join(root,'artifacts/new-test-profile.json'),JSON.stringify(profile,null,2));
fs.writeFileSync(path.join(root,'artifacts/critical-component-comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
