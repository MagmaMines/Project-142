// Control plane only: no Wasmer instance or user project executes in this Worker.
// Every top-level command group gets its own engine Worker, WASM memory and pool.
import {dependencyFingerprint,loadCheckpoint,saveCheckpoint,removeCheckpoint,receiveCacheResponse} from './cache-store.mjs';
import {installOPFSHostFileSystem} from './opfs-host-filesystem.mjs';
import {createStorageManager,isQuotaError,formatBytes,describeStorage,capacityMessage} from './storage-manager.mjs';
let files={},versions={},config={},projectId='',cwd='/workspace',checkpoint=null,initializing=false,closed=false,jobSequence=100,rpcSequence=0,connectionSequence=0;
const engines=new Map(),ports=new Map(),connections=new Map(),peerStreams=new Set(),peerIndex=new Map();let peerSequence=0;
const send=m=>{if(!closed)postMessage(m)};
const format=e=>String(e?.stack||e?.message||e).slice(0,8000);
/* Origin storage is shared by OPFS (execution mounts), IndexedDB (checkpoints,
 * snapshots) and the Cache API. Keep it measurable and reclaimable. */
const storage=createStorageManager({log:message=>send({type:'stderr',data:'[storage] '+message+'\n'})});
const liveMountNames=()=>new Set([...engines.values()].map(engine=>'workspace-'+(0x80000000+Number(engine.pid))));
async function storageSnapshot(){
 const report=await storage.report();
 let checkpointBytes=0;try{checkpointBytes=checkpoint?.bytes?.byteLength||0}catch{}
 return {...report,mounts:engines.size,checkpointBytes};
}
async function freeSpace({reportOnly=false}={}){
 const keep=liveMountNames();
 const removed=reportOnly?[]:await storage.sweep(keep);
 const report=await storageSnapshot();
 if(!reportOnly){send({type:'storage',report,removed});if(removed.length)send({type:'stdout',data:'[storage] freed '+removed.length+' stale execution mount(s): '+removed.join(', ')+'\n'})}
 return {report,removed};
}
const timeout=(promise,ms,message)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error(message)),ms);promise.then(v=>{clearTimeout(t);resolve(v)},e=>{clearTimeout(t);reject(e)})});
// Execution mounts are ephemeral: source and verified module checkpoints are
// synchronized elsewhere, so reclaim OPFS bytes even after forced worker death.
async function removeExecutionMount(pid){try{const root=await navigator.storage?.getDirectory?.();if(!root)return;const base=await root.getDirectoryHandle('beownir-wasix-v1');await base.removeEntry('workspace-'+(0x80000000+Number(pid)),{recursive:true})}catch(error){if(error?.name!=='NotFoundError')send({type:'stderr',data:'[opfs cleanup] '+String(error?.message||error)+'\n'})}}
function table(){send({type:'kernel-processes',processes:[...engines.values()].filter(e=>!e.utility&&!e.retired).map(e=>({pid:e.pid,ppid:0,state:e.server?'server':e.ready?'running':'starting',command:e.line,cwd:cwd.replace(/^\/workspace/,'/project'),startedAt:e.startedAt,ports:[...e.ports]}))})}
function postEngine(engine,message){if(engine.initSent)engine.worker.postMessage(message);else engine.queued.push(message)}
function coreCall(engine,method,args=[]){if(engine.retired)return Promise.reject(Error('Execution group has stopped'));const id=++rpcSequence;return new Promise((resolve,reject)=>{const timer=method==='tcpRead'?null:setTimeout(()=>{engine.pending.delete(id);reject(Error('Execution-group operation timed out'))},120000);engine.pending.set(id,{resolve,reject,timer});engine.worker.postMessage({type:'rpc',id,method,args})})}
function retire(engine,reason='Execution group finished'){
 if(engine.retired)return;engine.retired=true;for(const peer of [...peerStreams])if(peer.a.engine===engine||peer.b.engine===engine)void closePeer(peer);try{engine.hostMount?.dispose?.()}catch{}Promise.resolve(engine.worker.terminate()).finally(()=>void removeExecutionMount(engine.pid));clearTimeout(engine.deadline);
 for(const pending of engine.pending.values()){clearTimeout(pending.timer);pending.reject(Error(reason))}engine.pending.clear();
 for(const port of engine.ports)if(ports.get(port)===engine){ports.delete(port);send({type:'close',port});for(const other of engines.values())if(other!==engine&&other.ready&&!other.retired)void coreCall(other,'peerConfigure',[port,false]).catch(()=>{})}
 for(const[id,c]of connections)if(c.engine===engine)connections.delete(id);
 engines.delete(engine.pid);engine.rejectReady?.(Error(reason));engine.resolveReady=null;engine.rejectReady=null;table();
}
function failed(engine,error,raw=false){if(engine.retired)return;send({type:'stderr',data:'\n[group '+engine.pid+'] '+(raw?String(error?.message||error).slice(0,8000):format(error))+'\nThis isolated execution group was stopped; the browser renderer, other groups and committed dependencies remain available.\n'});if(isQuotaError(error)){send({type:'stderr',data:'\n\x1b[33m[storage]\x1b[0m The origin storage quota is exhausted (Storage capacity quota exceeded).\n\x1b[90mRun \x1b[0mstorage gc\x1b[90m or Help → Storage → Free space, then retry. .next output and package caches are rebuildable.\x1b[0m\n'});void freeSpace().catch(()=>{})}if(!engine.commandDone&&engine.commandId)send({type:'done',id:engine.commandId,code:1});retire(engine,'Execution group failed: '+String(error?.message||error).slice(0,1200))}
async function synchronizePeers(engine){for(const[port,owner]of ports)if(owner!==engine&&!owner.retired)await coreCall(engine,'peerConfigure',[port,true])}
function endpointKey(engine,socket){return engine.pid+'/'+socket}
async function closePeer(peer){if(peer.closed)return;peer.closed=true;peerStreams.delete(peer);peerIndex.delete(endpointKey(peer.a.engine,peer.a.socket));peerIndex.delete(endpointKey(peer.b.engine,peer.b.socket));await Promise.all([peer.a,peer.b].map(async end=>{if(!end.engine.retired)try{await coreCall(end.engine,'peerControl',[{action:'destroy',socket:end.socket}])}catch{}}))}
async function peerMessage(engine,message){
 if(message.type==='peer-open'){
  const owner=ports.get(message.port);if(!owner||owner===engine||owner.retired||peerStreams.size>=32){await coreCall(engine,'peerControl',[{action:'destroy',socket:message.socket}]);return}
  const peer={a:{engine,socket:message.socket},b:{engine:owner,socket:'up:'+ ++peerSequence},closed:false};peerStreams.add(peer);peerIndex.set(endpointKey(engine,message.socket),peer);peerIndex.set(endpointKey(owner,peer.b.socket),peer);
  try{await coreCall(owner,'peerControl',[{action:'connect',socket:peer.b.socket,port:message.port}]);await coreCall(owner,'peerControl',[{action:'ready',socket:peer.b.socket}]);await coreCall(engine,'peerControl',[{action:'ready',socket:message.socket}])}catch{await closePeer(peer)}return;
 }
 const peer=peerIndex.get(endpointKey(engine,message.socket));if(!peer||peer.closed)return;const source=peer.a.engine===engine&&peer.a.socket===message.socket?peer.a:peer.b,target=source===peer.a?peer.b:peer.a;
 try{
  if(message.type==='peer-data'){if(typeof message.data!=='string'||message.data.length>90000)throw Error('Loopback stream budget');await coreCall(target.engine,'peerControl',[{action:'data',socket:target.socket,data:message.data}]);await coreCall(source.engine,'peerControl',[{action:'credit',socket:source.socket}])}
  else if(message.type==='peer-end')await coreCall(target.engine,'peerControl',[{action:'end',socket:target.socket}]);else await closePeer(peer);
 }catch{await closePeer(peer)}
}
async function childMessage(engine,m){
 if(engine.retired)return;
 if(/^peer-(?:open|data|end|close|error)$/.test(m.type)){await peerMessage(engine,m);return}
 if(m.type==='ready'){engine.ready=true;engine.resolveReady?.();engine.resolveReady=null;engine.rejectReady=null;table();return}
 if(m.type==='kernel-processes')return;
 if(m.type==='checkpoint'){
  const checkpointId=String(m.id||'');
  if(!checkpointId){failed(engine,Error('Checkpoint is missing a commit id'));return}
  const fingerprint=await dependencyFingerprint(files);
  if(m.fingerprint!==fingerprint){const error='Dependencies changed during checkpoint; reinstall before reusing the cache.';send({type:'cache-state',state:'stale',message:error});postEngine(engine,{type:'checkpoint-result',id:checkpointId,error});return}
  try{checkpoint=await saveCheckpoint(projectId,fingerprint,m.bytes,m.info);send({type:'cache-state',state:'saved',bytes:m.bytes.byteLength,info:m.info});postEngine(engine,{type:'checkpoint-result',id:checkpointId,value:{persistent:true}})}catch(e){checkpoint={projectId,fingerprint,bytes:m.bytes,info:m.info};const message='Persistent dependency save failed: '+e.message;send({type:'cache-state',state:'memory',bytes:m.bytes.byteLength,message});postEngine(engine,{type:'checkpoint-result',id:checkpointId,value:{persistent:false,message}})}return;
 }
 if(m.type==='fssync'){
  const delta={},v={};for(const[p,value]of Object.entries(m.files||{})){const revision=Number(m.versions?.[p])||0;if((versions[p]||0)!==revision)continue;if(value===null)delete files[p];else files[p]=value;delta[p]=value;v[p]=revision}
  if(Object.keys(delta).length){send({type:'fssync',files:delta,versions:v});for(const other of engines.values())if(other!==engine&&!other.retired)postEngine(other,{type:'setfiles',files:delta,versions:v})}return;
 }
 if(m.type==='listen'){
  const owner=ports.get(m.port);if(owner&&owner!==engine){failed(engine,Error('EADDRINUSE: guest port '+m.port+' belongs to execution group '+owner.pid));return}
  ports.set(m.port,engine);engine.ports.add(m.port);for(const other of engines.values())if(other!==engine&&other.ready&&!other.retired)void coreCall(other,'peerConfigure',[m.port,true]).catch(error=>send({type:'stderr',data:'[loopback] '+error.message+'\n'}));if(!m.internal&&m.port!==24678)engine.server=true;send(m);table();return;
 }
 if(m.type==='close'){engine.ports.delete(m.port);if(ports.get(m.port)===engine){ports.delete(m.port);send(m);for(const other of engines.values())if(other!==engine&&other.ready&&!other.retired)void coreCall(other,'peerConfigure',[m.port,false]).catch(()=>{})}return}
 if(m.type==='done'){engine.commandDone=true;if(engine.server)clearTimeout(engine.deadline);send(m);return}
 if(m.type==='engine-exit'){if(!engine.commandDone)send({type:'done',id:engine.commandId,code:m.code||0});retire(engine);return}
 if(m.type==='storage-gc-request'){void freeSpace().catch(error=>send({type:'stderr',data:'[storage] '+format(error)+'\n'}));return}
 if(m.type==='fatal'){failed(engine,Error(m.message),true);return}
 if(!['connected','kernel-stopped'].includes(m.type))send(m);
}
async function createEngine({line='',commandId=null,utility=false,checkpointAfter=false,transactionalInstall=false}={}){
 if(engines.size>=3)throw Error('Browser memory budget: stop an execution group before starting another');
 const pid=jobSequence+1,hostMountId=0x80000000+pid;
 const hostMount=await installOPFSHostFileSystem(hostMountId,'workspace-'+hostMountId);
 let worker;try{worker=new Worker('/native-kernel.mjs',{type:'module',name:'Beownir execution group '+pid})}catch(error){hostMount.dispose?.();throw error}jobSequence=pid;
 const engine={worker,pid,line,commandId,utility,hostMount,ports:new Set(),pending:new Map(),ready:false,retired:false,server:false,startedAt:Date.now(),events:Promise.resolve(),commandDone:false,initSent:false,queued:[]};
 engines.set(pid,engine);engine.readyPromise=new Promise((resolve,reject)=>{engine.resolveReady=resolve;engine.rejectReady=reject});engine.readyPromise.catch(()=>{});
 worker.onmessage=({data:m})=>{if(!m||typeof m!=='object')return;if(m.type==='wasmer-filesystem-rpc'&&globalThis.__beownirHostFileSystemRpc?.(m)===true)return;if(m.type==='rpc-response'){const p=engine.pending.get(m.id);if(!p)return;engine.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.value);return}engine.events=engine.events.then(()=>childMessage(engine,m)).catch(error=>failed(engine,error))};
 worker.onerror=e=>{e.preventDefault();failed(engine,Error(e.message||'Execution Worker failed'))};worker.onmessageerror=()=>failed(engine,Error('Invalid execution-group message'));
 const copy=Object.fromEntries(Object.entries(files).map(([p,v])=>[p,v.d?{d:true}:{c:v.c}])),versionCopy={...versions};const fingerprint=await dependencyFingerprint(copy);const selectedCheckpoint=checkpoint?.fingerprint===fingerprint?checkpoint:null;
 worker.postMessage({type:'init',files:copy,versions:versionCopy,checkpoint:selectedCheckpoint,config:{...config,cwd,isolatedJobId:pid,needsNpm:/^\s*(?:npm|npx)(?:\s|$)/.test(line),checkpointAfter,transactionalInstall}});engine.initSent=true;for(const message of engine.queued)worker.postMessage(message);engine.queued=[];table();
 try{await timeout(engine.readyPromise,180000,'Execution engine startup timed out');await synchronizePeers(engine)}catch(e){retire(engine,e.message);throw e}return engine;
}
async function initialize(m){if(initializing)return;initializing=true;files=m.files||{};versions=m.versions||{};config=m.config||{};projectId=String(m.projectId||crypto.randomUUID());
 try{const persisted=await storage.persist();if(persisted.granted&&!persisted.persisted)send({type:'stderr',data:'[storage] this browser declined persistent storage; the workspace can be evicted when the device is low on space\n'})}catch{}
 try{const swept=await storage.sweep(liveMountNames());if(swept.length)send({type:'stdout',data:'[storage] reclaimed '+swept.length+' execution mount(s) left by an earlier session\n'})}catch{}
 try{checkpoint=await loadCheckpoint(projectId,await dependencyFingerprint(files));if(checkpoint)send({type:'cache-state',state:'available',bytes:checkpoint.bytes.byteLength,info:checkpoint.info})}catch(e){send({type:'cache-state',state:'error',message:e.message})}
 send({type:'ready'});table();
}
async function stopEngine(engine){if(engine.retired)return;try{await timeout(coreCall(engine,'stop'),1000,'Termination grace elapsed')}catch{}if(!engine.commandDone&&engine.commandId)send({type:'done',id:engine.commandId,code:130});retire(engine,'Execution group stopped')}
async function stopAll(){await Promise.all([...engines.values()].map(stopEngine));table()}
function localCommand(line,id){
 if(line.trim()==='clear'){send({type:'clear'});send({type:'done',id,code:0});return true}
 if(/^\s*cd(?:\s|$)/.test(line)&&!/[;&|<>`$]/.test(line)){let target=line.trim().slice(2).trim().replace(/^(['"])(.*)\1$/,'$2')||'/workspace';target=target.replace(/^~(?=\/|$)/,'/workspace').replace(/^\/project(?=\/|$)/,'/workspace');const parts=(target.startsWith('/')?target:cwd+'/'+target).split('/').filter(Boolean),out=[];for(const part of parts){if(part==='..')out.pop();else if(part!=='.')out.push(part)}if(out[0]!=='workspace')throw Error('cd is restricted to this workspace');const candidate='/'+out.join('/'),key=candidate.replace(/^\/workspace/,'/project');if(candidate!=='/workspace'&&!files[key]?.d)throw Error('Workspace directory does not exist: '+target);cwd=candidate;send({type:'done',id,code:0,cwd:key});return true}
 if(line.trim()==='help'){send({type:'stdout',data:'Browser WASIX Node · isolated execution groups\nUse npm/pnpm install, npm ci, npm run dev/build, node file.js.\nbeownir doctor / native-build / checkpoint / browser file.js\nEach command group has its own engine and port ownership. Source edits synchronize; committed dependencies/builds checkpoint to browser storage.\n'});send({type:'done',id,code:0});return true}return false;
}
async function execute(m){const line=String(m.line||'');if(!line.trim()||line.length>65536)throw Error('Invalid command');if(localCommand(line,m.id))return;
 const install=/^\s*(?:npm|pnpm)\s+(?:i|install|ci|add|update|up|remove|uninstall|rebuild)(?:\s|$)/.test(line),build=/^\s*(?:npm|pnpm)(?:\s+run)?\s+(?:build|generate)(?:\s|$)/.test(line)||/^\s*beownir\s+(?:native-build|checkpoint)(?:\s|$)/.test(line);
 if(install||build)await stopAll();
 if(install||build){
  const need=install?512*1024*1024:384*1024*1024;
  const verdict=await storage.ensureCapacity(need,install?'npm install':'the build',{keep:liveMountNames()});
  if(verdict.swept?.length)send({type:'stdout',data:'[storage] freed '+verdict.swept.length+' stale execution mount(s) before the command\n'});
  if(!verdict.ok){send({type:'stderr',data:capacityMessage(verdict,install?'npm install':'the build')+'\n'});send({type:'done',id:m.id,code:1});return}
 }
 const engine=await createEngine({line,commandId:m.id,checkpointAfter:install||build,transactionalInstall:install});
 const budget=install?300000:900000;
 engine.deadline=setTimeout(()=>failed(engine,Error(install?'Package operation exceeded the five-minute browser budget':'Execution group exceeded 15-minute budget')),budget);
 engine.worker.postMessage({type:'cmd',line,id:m.id});
}
function publicPort(port){if(!Number.isInteger(port)||port<1||port>65535||port>=60000&&port<=62001)throw Error('Invalid or reserved guest port');const e=ports.get(port);if(!e||e.retired)throw Error('No execution group listens on guest port '+port);return e}
const rpc={
 async tcpOpen(port){const engine=publicPort(port);if(connections.size>=32)throw Error('Preview TCP limit');const local=await coreCall(engine,'tcpOpen',[port]),id=++connectionSequence;connections.set(id,{engine,local});return id},
 async tcpRead(id){const c=connections.get(id);if(!c)return new Uint8Array();return coreCall(c.engine,'tcpRead',[c.local])},
 async tcpWrite(id,data){const c=connections.get(id);if(!c)throw Error('Preview connection is closed');return coreCall(c.engine,'tcpWrite',[c.local,data])},
 async tcpClose(id){const c=connections.get(id);if(!c)return;connections.delete(id);if(!c.engine.retired)await coreCall(c.engine,'tcpClose',[c.local])},
 async http(port,url,options){return coreCall(publicPort(port),'http',[port,url,options])},
 async stop(){await stopAll()},async kill(id,signal='SIGTERM'){const engine=engines.get(id);if(!engine)throw Error('No active execution group '+id);if(signal==='SIGKILL'){if(!engine.commandDone)send({type:'done',id:engine.commandId,code:130});retire(engine,'Execution group forcibly stopped')}else if(signal==='SIGTERM')await stopEngine(engine);else throw Error('Execution-group control supports SIGTERM or SIGKILL')},
 async exportBuild(root){if(!['dist','.next','.output'].includes(root))throw Error('Invalid build directory');const engine=await createEngine({utility:true});try{return await coreCall(engine,'exportBuild',[root])}finally{retire(engine)}},
 cacheStatus(){return{available:Boolean(checkpoint),bytes:checkpoint?.bytes.byteLength||0,fingerprint:checkpoint?.fingerprint||null}},
 async clearCache(){await removeCheckpoint(projectId);checkpoint=null;send({type:'cache-state',state:'empty'})},
 async shutdown(){await stopAll();closed=true;postMessage({type:'kernel-stopped'});self.close()},
};
onmessage=({data:m})=>{if(!m||typeof m!=='object')return;if(receiveCacheResponse(m))return;
 if(m.type==='storage-report'){void freeSpace({reportOnly:true}).catch(()=>{});return}
 if(m.type==='storage-gc'){void freeSpace().catch(error=>send({type:'stderr',data:'[storage] '+format(error)+'\n'}));return}
 if(m.type==='storage-persist'){void storage.persist().then(result=>send({type:'storage',report:result.report,persisted:result.persisted})).catch(()=>{});return}if(m.type==='init'){void initialize(m).catch(e=>send({type:'fatal',message:format(e)}));return}if(m.type==='setfiles'){for(const[p,v]of Object.entries(m.files||{})){if(v===null)delete files[p];else files[p]=v;versions[p]=Number(m.versions?.[p])||0}for(const e of engines.values())if(!e.retired)postEngine(e,m);return}if(m.type==='cmd'){void execute(m).catch(e=>{send({type:'stderr',data:format(e)+'\n'});send({type:'done',id:m.id,code:1})});return}if(m.type==='input'){const e=[...engines.values()].find(x=>!x.server&&!x.utility);e?.worker.postMessage(m);return}if(m.type==='terminate'){void rpc.shutdown();return}if(m.type==='rpc'){if(!Object.prototype.hasOwnProperty.call(rpc,m.method)){send({type:'rpc-response',id:m.id,error:'Unsupported supervisor operation'});return}Promise.resolve().then(()=>rpc[m.method](...(m.args||[]))).then(value=>send({type:'rpc-response',id:m.id,value}),e=>send({type:'rpc-response',id:m.id,error:format(e)}))}};
