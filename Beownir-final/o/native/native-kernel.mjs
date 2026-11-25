import {installSyscallBroker,replySyscall} from '/syscall-broker.mjs';
import {Wasmer} from '/node_modules/@wasmer/sdk/dist/index.js';
import {installHostFileSystemWorkerBridge} from '/node_modules/@wasmer/sdk/dist/host-filesystem.js';
import {isQuotaError,formatBytes,describeStorage,capacityVerdict,capacityMessage} from '/storage-manager.mjs';
let client,sandbox,cwd='/workspace',sequence=0,foreground,scanTimer,portStop,publicConfig={},metadataAgent,metadataToken;
const peerPorts=new Set(),peerPending=new Map();let peerSequence=0;
const jobs=new Map(),connections=new Map(),known=new Map(),revisions=new Map(),knownDirs=new Set(),checkpointPending=new Map();let checkpointSequence=0;
let initialization=Promise.resolve();
let connectionSequence=0,writing=Promise.resolve(),io=Promise.resolve(),closed=false,scanQueued=false,finishing=false;
const binary=bytes=>{let text='';for(let n=0;n<bytes.length;n+=16384)text+=String.fromCharCode(...bytes.subarray(n,n+16384));return '__BEOWNIR_WASM64__:'+btoa(text)};
installSyscallBroker(handleSyncRequest);
// Main SDK calls run inside this worker too. Route their synchronous host-FS
// RPCs (and requests forwarded from SDK child workers) to the supervisor,
// where asynchronous OPFS operations can complete without blocking this worker.
installHostFileSystemWorkerBridge();
const send=m=>{if(!closed)postMessage(m)},encoder=new TextEncoder(),decoder=new TextDecoder();
const fail=e=>String(e?.stack||e?.message||e).slice(0,9000);
/* ---------- storage governor ----------
 * The browser gives one origin quota to OPFS + IndexedDB + Cache. Next.js
 * writes a large .next tree, so a full disk is a normal outcome, not an
 * exceptional one: measure it, free rebuildable state, retry, and always say
 * what happened instead of surfacing a raw "Storage capacity quota exceeded". */
const INSTALL_HEADROOM=512*1024*1024,BUILD_HEADROOM=384*1024*1024;
const quotaHint='\n\x1b[33m[storage]\x1b[0m The browser origin is out of space (Storage capacity quota exceeded).\n'
 +'\x1b[90mRebuildable data is never required to finish: run \x1b[0mstorage gc\x1b[90m here, or Help → Storage → Free space,\n'
 +'then retry. .next build output and package caches are recreated on demand.\x1b[0m\n';
async function storageReport(){
 try{if(typeof navigator.storage?.estimate!=='function')return null;const estimate=await navigator.storage.estimate();let persisted=false;try{persisted=await navigator.storage.persisted()}catch{}return describeStorage(estimate,persisted)}catch{return null}
}
async function guestGc(){
 try{const out=await internalNode(['.beownir/workspace-cache.cjs','gc']);if(out.exitCode!==0)return null;const lines=out.stdout.text().trim().split('\n');return JSON.parse(lines[lines.length-1])}catch{return null}
}
function reportLine(report){
 if(!report)return 'Storage: this browser does not expose usage information.';
 return 'Storage · used '+formatBytes(report.usage)+' of '+formatBytes(report.quota)+' ('+Math.round(report.usedRatio*100)+'%), '
  +formatBytes(report.available)+' free · '+(report.persisted?'persistent':'best effort (may be evicted)')+'\n';
}
/* Runs before an install or build; returns a blocking message or null. */
async function storagePreflight(label,need){
 const report=await storageReport();if(!report||report.quota<=0)return null;
 if(capacityVerdict(report,need).ok)return null;
 send({type:'progress',phase:'Freeing rebuildable storage'});
 const freed=await guestGc(),after=await storageReport();
 if(capacityVerdict(after,need).ok){send({type:'stdout',data:'[storage] freed '+formatBytes(freed?.freedBytes||0)+' of rebuildable cache to make room for '+label+'\n'});return null}
 return capacityMessage(capacityVerdict(after,need),label);
}
async function guestTreeSizes(limit=12){
 const rows=[];let total=0,entries=0;
 const walk=async(rel)=>{for(const item of await sandbox.fs.readDir(rel||'.')){if(++entries>20000)return;const name=rel?rel+'/'+item.name:item.name;if(item.kind==='directory'){await walk(name);continue}try{const stat=await sandbox.fs.stat(name);const size=Number(stat?.size)||0;total+=size;rows.push({name,size})}catch{}}};
 try{await walk('')}catch{}
 const dirs=new Map();
 for(const row of rows){const top=row.name.includes('/')?row.name.slice(0,row.name.indexOf('/')):'(files)';dirs.set(top,(dirs.get(top)||0)+row.size)}
 return {total,entries,dirs:[...dirs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit)};
}
async function storageCommand(line,commandId){
 const parts=line.trim().split(/\s+/),sub=(parts[1]||'df').toLowerCase();
 const finish=code=>{send({type:'done',id:commandId,code});send({type:'engine-exit',code})};
 if(['df','status','info'].includes(sub)){
  send({type:'stdout',data:reportLine(await storageReport())});
  const sizes=await guestTreeSizes();
  if(sizes.dirs.length)send({type:'stdout',data:'Workspace · '+formatBytes(sizes.total)+' in '+sizes.entries+' files\n'+sizes.dirs.map(([name,size])=>'  '+formatBytes(size).padStart(9)+'  '+name+'/\n').join('')});
  send({type:'storage',report:await storageReport(),dirs:sizes.dirs,guestBytes:sizes.total});
  finish(0);return;
 }
 if(['gc','clean','free'].includes(sub)){
  send({type:'progress',phase:'Freeing rebuildable storage'});
  const freed=await guestGc();
  if(!freed){send({type:'stderr',data:'storage gc could not run in this guest\n'});finish(1);return}
  for(const entry of freed.freed)send({type:'stdout',data:'  freed '+(entry.error?'(skipped) '+entry.path+' — '+entry.error:formatBytes(entry.bytes).padStart(9)+'  '+entry.path)+'\n'});
  send({type:'stdout',data:'storage gc · '+formatBytes(freed.freedBytes)+' reclaimed\n'+reportLine(await storageReport())});
  send({type:'storage-gc-request'});
  send({type:'storage',report:await storageReport(),freedBytes:freed.freedBytes});
  finish(0);return;
 }
 send({type:'stderr',data:'Usage: storage df | storage gc\n'});finish(1);
}
const clean=p=>{if(typeof p!=='string'||p.length>768||p.includes('\\')||p.includes('\0')||p.split('/').includes('..'))throw Error('Invalid workspace path');return p.startsWith('/project/')?p.slice(9):p==='/project'?'':p.replace(/^\/workspace\/?/,'').replace(/^\//,'')};
const ignored=new Set(['node_modules','.git','.next','.nuxt','.output','dist','.beownir','.cache','.local','.npm','.pnpm-store','coverage']);
const fileTask=fn=>{const result=io.then(fn);io=result.catch(()=>{});return result};
const table=()=>send({type:'kernel-processes',processes:[...jobs.values()].filter(j=>!j.ended).map(j=>({pid:j.id,ppid:0,state:j.background?'server':'running',command:j.line,cwd:cwd.replace(/^\/workspace/,'/project'),startedAt:j.startedAt,ports:[...j.ports]}))});
function done(job,code){if(job.sentDone)return;job.sentDone=true;if(foreground===job)foreground=null;send({type:'done',id:job.commandId,code,cwd:cwd.replace(/^\/workspace/,'/project')})}
async function putFiles(files,versions={}){
 const touched=new Set(['.']);
 for(const[p,value]of Object.entries(files||{})){
  const relative=clean(p);if(!relative||relative.startsWith('.beownir/'))continue;revisions.set(relative,Number(versions[p])||0);
  let parent=relative;while(parent){touched.add(parent);parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):''}
  if(value===null){try{await sandbox.fs.remove(relative,{recursive:true})}catch(e){if(!/not found|ENOENT/i.test(e.message))throw e}known.delete(relative);knownDirs.delete(relative);continue}
  if(value.d){await sandbox.fs.mkdir(relative,{recursive:true});knownDirs.add(relative);continue}if(typeof value.c!=='string')continue;
  if(relative.includes('/'))await sandbox.fs.mkdir(relative.slice(0,relative.lastIndexOf('/')),{recursive:true});
  if(value.c.startsWith('__BEOWNIR_WASM64__:')){const raw=atob(value.c.slice(19));await sandbox.fs.writeFile(relative,Uint8Array.from(raw,x=>x.charCodeAt(0)))}else await sandbox.fs.writeText(relative,value.c);
  known.set(relative,value.c);
 }
 if(metadataAgent){const response=await sandbox.ports.request(62001,'/touch',{method:'POST',headers:{'content-type':'application/json','x-beownir-fs-token':metadataToken},body:encoder.encode(JSON.stringify([...touched]))});try{if(response.status!==200)throw Error('Source metadata update failed: '+decoder.decode(response.body))}finally{response.free()}}
}
async function scanImpl(){
 if(!sandbox||closed)return;
 const pending=[''],found=new Set(),foundDirs=new Set(),delta={},versions={};let entries=0;
 while(pending.length){const dir=pending.pop();for(const item of await sandbox.fs.readDir(dir||'.')){
  if(++entries>20000)throw Error('Source sync entry limit');const relative=dir?dir+'/'+item.name:item.name;
  if(item.kind==='directory'&&ignored.has(item.name))continue;
  if(item.kind==='directory'){foundDirs.add(relative);if(!knownDirs.has(relative)){knownDirs.add(relative);delta['/project/'+relative]={d:true};versions['/project/'+relative]=revisions.get(relative)||0}pending.push(relative);continue}
  found.add(relative);const stat=await sandbox.fs.stat(relative);if(stat.size>16*1024*1024)continue;const bytes=await sandbox.fs.readFile(relative);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))text=binary(bytes)}catch{text=binary(bytes)};
  if(known.get(relative)!==text){known.set(relative,text);delta['/project/'+relative]={c:text};versions['/project/'+relative]=revisions.get(relative)||0}
 }}
 for(const relative of [...known.keys()])if(!found.has(relative)&&!relative.split('/').some(x=>ignored.has(x))){known.delete(relative);delta['/project/'+relative]=null;versions['/project/'+relative]=revisions.get(relative)||0}
 for(const relative of [...knownDirs])if(!foundDirs.has(relative)&&!relative.split('/').some(x=>ignored.has(x))){knownDirs.delete(relative);delta['/project/'+relative]=null;versions['/project/'+relative]=revisions.get(relative)||0}
 if(Object.keys(delta).length)send({type:'fssync',files:delta,versions});
}
async function scan(force=false){if(scanQueued||closed||!sandbox||publicConfig.transactionalInstall&&!force&&foreground&&!foreground.ended)return;scanQueued=true;try{await fileTask(scanImpl)}catch(e){send({type:'stderr',data:'[source sync] '+e.message+'\n'})}finally{scanQueued=false}}
async function drainMetadata(){const decoder=new TextDecoder();let buffer='';try{for await(const bytes of metadataAgent.stdout){buffer+=decoder.decode(bytes,{stream:true});if(buffer.length>2*1024*1024)throw Error('Peer control framing budget');for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const message=JSON.parse(line);if(message.type==='peer-reply'){const p=peerPending.get(message.rid);if(p){peerPending.delete(message.rid);clearTimeout(p.timer);message.error?p.reject(Error(message.error)):p.resolve(message.value)}}else if(/^peer-(?:open|data|end|close|error)$/.test(message.type))send(message)}}}catch(error){if(!closed)send({type:'fatal',message:'Peer control failed: '+error.message})}}
function peerControl(message){const rid=++peerSequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{peerPending.delete(rid);reject(Error('Peer control timed out'))},15000);peerPending.set(rid,{resolve,reject,timer});void metadataAgent.stdin.write(JSON.stringify({...message,rid})+'\n').catch(error=>{clearTimeout(timer);peerPending.delete(rid);reject(error)})})}
async function peerConfigure(port,active){validatePort(port);if(active)peerPorts.add(port);else peerPorts.delete(port);const r=await sandbox.ports.request(62001,'/peers',{method:'POST',headers:{'content-type':'application/json','x-beownir-fs-token':metadataToken},body:encoder.encode(JSON.stringify({port,active}))});try{if(r.status!==200)throw Error('Peer port configuration failed: '+decoder.decode(r.body))}finally{r.free()}if(!active)peerPorts.delete(port)}
async function handleSyncRequest(request){
 try{
  if(!sandbox||request.kind!=='spawnSync'||typeof request.file!=='string'||request.file.length>1024||!Array.isArray(request.args)||request.args.length>1024||request.args.some(x=>typeof x!=='string'||x.length>65536))throw Error('Invalid synchronous subprocess request');
  const max=Math.trunc(Number(request.maxBuffer)||1024*1024);if(max<1||max>32*1024*1024)throw Error('Subprocess capture budget exceeded');
  const env={};for(const[key,value]of Object.entries(request.env||{})){if(key.length>256||String(value).length>32768)throw Error('Invalid child environment');env[key]=String(value)}
  env.BEOWNIR_JOB_ID=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
  const options={stdin:'pipe',stdout:'capture',stderr:'capture',outputBytes:max*2};if(request.timeout>0)options.timeoutMs=Math.min(request.timeout,900000);
  const process=await sandbox.command(request.file,request.args,{cwd:request.cwd||cwd,env}).spawn(options);
  if(request.input?.byteLength)await process.stdin.write(request.input);await process.stdin.close();const result=await process.wait();
  const error=result.stdout.truncated||result.stderr.truncated?{code:'ENOBUFS',message:'Subprocess maxBuffer exceeded'}:result.reason==='timedOut'?{code:'ETIMEDOUT',message:'Subprocess timed out'}:null;
  replySyscall(request,{pid:process.id||process.pid||1,status:result.exitCode,stdout:result.stdout.bytes,stderr:result.stderr.bytes,error});
 }catch(error){replySyscall(request,{error:{message:error.message,code:error.code||'EIO'}})}
}
async function internalNode(args,env={}){const p=await sandbox.command('node',args,{cwd:'/workspace',env}).spawn({stdin:'closed',stdout:'capture',stderr:'capture',outputBytes:256*1024});return p.wait()}
async function checkpoint(){
 send({type:'progress',phase:'Saving modules / build checkpoint'});
 let out=await internalNode(['.beownir/workspace-cache.cjs','pack','/workspace/.beownir/checkpoint.bin']);
 if(out.exitCode!==0&&isQuotaError(out.stderr.text()||out.stdout.text())){
  send({type:'stdout',data:'[storage] checkpoint needs space; freeing rebuildable cache (.next/cache, package caches) and retrying\n'});
  const freed=await guestGc();if(freed)send({type:'stdout',data:'[storage] freed '+formatBytes(freed.freedBytes)+'\n'});
  out=await internalNode(['.beownir/workspace-cache.cjs','pack','/workspace/.beownir/checkpoint.bin']);
 }
 if(out.exitCode!==0){
  const detail=out.stderr.text()||out.stdout.text();
  throw Error(isQuotaError(detail)?quotaHint.trim():'Checkpoint failed: '+detail);
 }
 const lines=out.stdout.text().trim().split('\n'),info=JSON.parse(lines[lines.length-1]),bytes=await sandbox.fs.readFile('.beownir/checkpoint.bin');
 const id='checkpoint-'+(++checkpointSequence);
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{checkpointPending.delete(id);reject(Error('Checkpoint commit acknowledgement timed out'))},90000);
  checkpointPending.set(id,{resolve,reject,timer});send({type:'checkpoint',id,fingerprint:info.fingerprint,bytes,info});
 });
 try{await sandbox.fs.remove('.beownir/cache-dirty')}catch{}
}
async function verifyInstallReceipt(){
 const program="const fs=require('node:fs'),p='/workspace/.beownir/install-materialized.json';const r=JSON.parse(fs.readFileSync(p,'utf8'));if(!Number.isInteger(r.directDependencies)||r.directDependencies<0||(r.directDependencies>0&&!fs.statSync('/workspace/node_modules').isDirectory()))throw Error('install receipt or materialized node_modules is invalid');process.stdout.write('install-receipt-ok')";
 const out=await internalNode(['-e',program]);
 if(out.exitCode!==0||!out.stdout.text().includes('install-receipt-ok'))throw Error('Install exited without a verified filesystem materialization receipt: '+(out.stderr.text()||out.stdout.text()||'no output'));
}
async function stopJobs(){for(const job of jobs.values())if(!job.ended){try{await job.process.terminate({gracePeriodMs:500})}catch{}job.ended=true;done(job,130)}table()}
async function initialize(files,versions,config,cache){
 publicConfig=config||{};cwd=publicConfig.cwd||'/workspace';
 // The supervisor owns this group's OPFS directory and services the
 // synchronous bridge. storageHost replaces the SDK-reserved `/workspace`.
 const hostMountId=0x80000000+(Number(publicConfig.isolatedJobId)||0);
 if(typeof globalThis.__wasmerHostFileSystem!=='function')throw Error('SDK host filesystem bridge was not installed in the execution worker');
 client=new Wasmer({cache:{namespace:'beownir-native-v3'},parallelism:2,outputBytes:2*1024*1024});const initial={};
 for(const[p,v]of Object.entries(files||{})){
  const r=clean(p);if(!r)continue;if(v?.d){knownDirs.add(r);continue}
  if(typeof v?.c!=='string'||r.split('/').some(x=>ignored.has(x)))continue;
  if(v.c.startsWith('__BEOWNIR_WASM64__:')){const raw=atob(v.c.slice(19));initial[r]=Uint8Array.from(raw,c=>c.charCodeAt(0))}else initial[r]=v.c;
  known.set(r,v.c);revisions.set(r,Number(versions?.[p])||0);
 }
 initial['.npmrc']??='fetch-retries=3\nfetch-retry-mintimeout=1000\nfetch-retry-maxtimeout=4000\nfetch-timeout=120000\nignore-scripts=true\nupdate-notifier=false\n';
 const helpers=['portable.cjs','portable-async.cjs','portable-diagnostics.cjs','portable-net.cjs','portable-watch.cjs','portable-watch-file.cjs','portable-process-tree.cjs','portable-fs.cjs','portable-wasi.cjs','fs-metadata-agent.cjs','peer-agent.cjs','workspace-cache.cjs','npm-bootstrap.cjs','package-manager.cjs','compatibility-policy.cjs','native-addons.cjs','portable-modules.cjs','portable-subprocess.cjs','runtime-probe.cjs','cli.cjs','semver.cjs'];
 for(const name of helpers){const response=await fetch('/'+name);if(!response.ok)throw Error('Missing embedded helper '+name);initial['.beownir/'+name]=await response.text()}
 const ipcToken=Array.from(crypto.getRandomValues(new Uint8Array(24)),x=>x.toString(16).padStart(2,'0')).join(''),endpoint=new URL('/tcp/',self.location.origin).href.replace(/^http/,'ws');
 let edgePackage;let registryError;for(let attempt=0;attempt<3;attempt++){try{send({type:'progress',phase:'Acquiring wasmer/edgejs@=0.2.5'+(attempt?' · retry '+attempt+'/2':'')});edgePackage=await client.packages.load('wasmer/edgejs@=0.2.5');break}catch(error){registryError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,800*(2**attempt)))}}if(!edgePackage)throw Error('Unable to acquire the browser WASIX runtime package wasmer/edgejs@=0.2.5 from registry.wasmer.io after 3 attempts: '+fail(registryError));
 sandbox=await client.sandboxes.create({packages:[edgePackage],files:{},storageHost:hostMountId,env:{BEOWNIR_IPC_TOKEN:ipcToken,HOME:'/workspace',PATH:'/workspace/node_modules/.bin:/workspace/.beownir/global/bin:/.wasix/bin:/usr/local/bin:/usr/bin:/bin',WATCHPACK_POLLING:'500',CHOKIDAR_USEPOLLING:'true',CHOKIDAR_INTERVAL:'250',NAPI_RS_FORCE_WASI:'1',NEXT_TELEMETRY_DISABLED:'1',NUXT_TELEMETRY_DISABLED:'1',npm_config_update_notifier:'false',PNPM_DISABLE_SELF_UPDATE_CHECK:'1',UV_THREADPOOL_SIZE:'2',NAPI_RS_ASYNC_WORK_POOL_SIZE:'1',ESBUILD_WORKER_THREADS:'0',npm_config_cache:'/workspace/.beownir/npm-cache',npm_config_prefix:'/workspace/.beownir/global',NODE_OPTIONS:'--require=/workspace/.beownir/portable.cjs',BEOWNIR_CLIENT_PORT:String(publicConfig.clientPort||443),BEOWNIR_CLIENT_PROTOCOL:publicConfig.clientProtocol||'wss',BEOWNIR_CLIENT_HOST:publicConfig.clientHost||'localhost'},network:{mode:'wisp',url:endpoint,dnsUrl:new URL('/dns-query',self.location.origin).href},onPackageProgress:p=>send({type:'progress',phase:p.phase,bytes:p.download.downloadedBytes,total:p.download.totalBytes})});
 for(const dir of [...knownDirs].sort((a,b)=>a.length-b.length))if(!dir.split('/').some(x=>ignored.has(x)))await sandbox.fs.mkdir(dir,{recursive:true});
 try{for(const [name,value] of Object.entries(initial)){if(name.includes('/'))await sandbox.fs.mkdir(name.slice(0,name.lastIndexOf('/')),{recursive:true});if(typeof value==='string')await sandbox.fs.writeText(name,value);else await sandbox.fs.writeFile(name,value);}}catch(error){throw Error('OPFS initial workspace write failed: '+error.message)}
 // Verify visibility through the guest VFS, not only the SDK facade, before
 // allowing NODE_OPTIONS to preload a helper from the browser-owned mount.
 const mountProbe=await sandbox.command('node',['-e',"require('fs').accessSync('/workspace/.beownir/portable.cjs');process.stdout.write('opfs-guest-visible')"],{cwd:'/workspace',env:{NODE_OPTIONS:''}}).spawn({stdin:'closed',stdout:'capture',stderr:'capture',outputBytes:65536});
 const mountProbeResult=await mountProbe.wait();if(mountProbeResult.exitCode!==0||!mountProbeResult.stdout.text().includes('opfs-guest-visible'))throw Error('OPFS guest mount verification failed: '+(mountProbeResult.stderr.text()||mountProbeResult.stdout.text()||'no output'));
 // Run real behavior probes in the unshimmed WASIX Node process. API names in
 // the browser compatibility layer do not count as native Node evidence.
 try{
  const nativeProbe=await internalNode(['.beownir/runtime-probe.cjs'],{NODE_OPTIONS:''});
  if(nativeProbe.exitCode===0){const lines=nativeProbe.stdout.text().trim().split(/\r?\n/);const capabilities=JSON.parse(lines[lines.length-1]);send({type:'native-capabilities',capabilities})}
  else send({type:'native-capabilities',capabilities:{nodeVersion:null,probeError:(nativeProbe.stderr.text()||nativeProbe.stdout.text()||'native probe exited '+nativeProbe.exitCode).slice(0,500)}});
 }catch(error){send({type:'native-capabilities',capabilities:{nodeVersion:null,probeError:String(error?.message||error).slice(0,500)}})}
 metadataToken=Array.from(crypto.getRandomValues(new Uint8Array(24)),x=>x.toString(16).padStart(2,'0')).join('');
 metadataAgent=await sandbox.command('node',['.beownir/fs-metadata-agent.cjs'],{cwd:'/workspace',env:{BEOWNIR_FS_TOKEN:metadataToken}}).spawn({stdin:'pipe',stdout:'pipe',stderr:'capture',outputBytes:2*1024*1024});
 void drainMetadata();
 const metadataExit=metadataAgent.wait();
 await Promise.race([sandbox.ports.wait(62001,{timeoutMs:60000}),metadataExit.then(out=>{throw Error('Execution-group filesystem daemon exited before listening (code '+out.exitCode+'): '+(out.stderr.text()||out.stdout.text()||'no output'))})]);
 void metadataExit.then(out=>{
  if(!closed)send({type:'fatal',message:'Execution-group filesystem daemon exited (code '+out.exitCode+'): '+(out.stderr.text()||out.stdout.text()||'no output')});
 });
 if(cache?.bytes){send({type:'progress',phase:'Restoring cached modules / build'});await sandbox.fs.writeFile('.beownir/checkpoint.bin',cache.bytes);const result=await internalNode(['.beownir/workspace-cache.cjs','restore','/workspace/.beownir/checkpoint.bin',cache.fingerprint]);if(result.exitCode!==0)throw Error('Dependency restore failed: '+result.stderr.text());send({type:'cache-state',state:'restored',bytes:cache.bytes.byteLength})}try{await sandbox.fs.remove('.beownir/cache-dirty')}catch{}
 if(publicConfig.needsNpm){let installed=false;try{const meta=JSON.parse(await sandbox.fs.readText('.beownir/npm-cli/node_modules/npm/package.json'));installed=meta.version==='11.21.1'}catch{}if(!installed){send({type:'progress',phase:'Installing the official npm 11.21.1 CLI'});const npm=await internalNode(['.beownir/npm-bootstrap.cjs']);if(npm.exitCode!==0)throw Error(npm.stderr.text()||npm.stdout.text());await checkpoint()}}
 portStop=sandbox.ports.onListen(port=>{if(peerPorts.has(port)||port===0||port>=60000&&port<=62001)return;send({type:'listen',port,internal:port>=49152});if(foreground&&port!==24678&&port<49152){foreground.background=true;foreground.ports.add(port);done(foreground,0);table()}},{intervalMs:100,onClose:port=>{if(!peerPorts.has(port)&&!(port>=60000&&port<=62001))send({type:'close',port})}});
 scanTimer=setInterval(()=>void scan(),4000);send({type:'ready'});table();
}
async function execute(line,commandId){
 if(!sandbox)throw Error('Node engine is not ready');if(foreground&&!foreground.ended)throw Error('One top-level command is allowed in this execution group');await writing;
 const originalLine=line,isInstallCommand=/^\s*(?:npm|pnpm)\s+(?:i|install|ci|add|update|up|remove|uninstall|rebuild)(?:\s|$)/.test(line);
 if(/^\s*storage(?:\s|$)/.test(line)){await storageCommand(line,commandId);return}
 const isBuildCommand=/^\s*(?:npm|pnpm)(?:\s+run)?\s+(?:build|generate)(?:\s|$)|^\s*beownir\s+(?:native-build|checkpoint)(?:\s|$)|^\s*(?:npx\s+)?(?:vite|next|nuxt)\s+build(?:\s|$)/.test(line);
 if(isInstallCommand||isBuildCommand){const blocked=await storagePreflight(isInstallCommand?'npm install':'the build',isInstallCommand?INSTALL_HEADROOM:BUILD_HEADROOM);if(blocked){send({type:'stderr',data:blocked+'\n'});send({type:'done',id:commandId,code:1});send({type:'engine-exit',code:1});return}}
 let nativeSources=false;try{const pkg=JSON.parse(await sandbox.fs.readText('package.json'));nativeSources=Object.values(pkg.beownir?.nativeAddons||{}).some(d=>d.sources?.length)}catch{}
 if(nativeSources&&/^\s*(?:beownir\s+native-build|(?:npm|pnpm)\s+(?:i|install|ci|add|rebuild))(?:\s|$)/.test(line)){send({type:'progress',phase:'Loading browser-WASM Clang toolchain'});let pkg;try{pkg=await sandbox.installPackage('clang/clang@=0.160000.1',{onProgress:p=>send({type:'progress',phase:p.phase,bytes:p.download.downloadedBytes,total:p.download.totalBytes})});await sandbox.fs.writeText('.beownir/toolchain.json',JSON.stringify({package:pkg.id,commands:pkg.commands}));}catch(error){send({type:'stderr',data:'[compiler] '+error.message+'; declared JS fallback remains available.\n'})}}
 line=line.replace(/^\s*npx(?=\s|$)/,'node /workspace/.beownir/npm-cli/node_modules/npm/bin/npx-cli.js');
 line=line.replace(/^\s*npm(?=\s|$)/,'node /workspace/.beownir/package-manager.cjs npm');
 line=line.replace(/^\s*pnpm(?=\s+(?:i|install|ci|add|update|up|remove|uninstall|rebuild)(?:\s|$))/,'node /workspace/.beownir/package-manager.cjs pnpm');
 line=line.replace(/^\s*beownir(?=\s|$)/,'node /workspace/.beownir/cli.cjs');
 const jobToken=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
 const p=await sandbox.command('sh',['-c',line],{cwd,env:{BEOWNIR_JOB_ID:jobToken}}).spawn({stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 const job={id:publicConfig.isolatedJobId||100+(++sequence),process:p,commandId,line:originalLine,install:isInstallCommand,startedAt:Date.now(),ports:new Set(),ended:false,sentDone:false,background:false};jobs.set(job.id,job);foreground=job;table();
 const drain=async(stream,type,watch)=>{const text=new TextDecoder();try{for await(const bytes of stream){const value=text.decode(bytes,{stream:true});if(value){if(!watch||!watch(value))send({type,data:value})}}const rest=text.decode();if(rest&&!(watch&&watch(rest)))send({type,data:rest})}catch(e){if(!closed)send({type:'stderr',data:'[process stream] '+e.message+'\n'})}};
 let quotaReported=false;
 const quotaWatch=value=>{if(quotaReported||!isQuotaError(value))return false;quotaReported=true;send({type:'stderr',data:quotaHint});return true};
 void drain(p.stdout,'stdout');void drain(p.stderr,'stderr',quotaWatch);
 void p.wait().then(async out=>{
  finishing=true;await writing;let finalCode=out.exitCode;
  if(!publicConfig.transactionalInstall||out.exitCode===0)await scan(true);
  if(job.install&&out.exitCode===0)try{send({type:'progress',phase:'Verifying filesystem materialization'});await verifyInstallReceipt()}catch(e){send({type:'stderr',data:'[install] '+e.message+'\n'});finalCode=1}
  let dirty=false;try{await sandbox.fs.stat('.beownir/cache-dirty');dirty=true}catch{}
  if((publicConfig.checkpointAfter||dirty)&&finalCode===0)try{await checkpoint();if(job.install)send({type:'stdout',data:'✓ Install completed: package manager exit, filesystem materialization and checkpoint commit all succeeded.\n'})}catch(e){send({type:'cache-state',state:'error',message:e.message});send({type:'stderr',data:'[checkpoint] '+e.message+'\n'});finalCode=1}
  job.ended=true;done(job,finalCode);table();send({type:'engine-exit',code:finalCode});
 },error=>{job.ended=true;done(job,1);send({type:'stderr',data:fail(error)+'\n'});table();send({type:'engine-exit',code:1})}).catch(error=>send({type:'fatal',message:fail(error)}));
}
function track(entry,promise){entry.pending.add(promise);return promise.finally(()=>entry.pending.delete(promise))}
const validatePort=port=>{if(!Number.isInteger(port)||port<1||port>65535||port>=60000&&port<=62001)throw Error('Invalid or reserved guest port')};
const rpc={
 peerControl,peerConfigure,
 tcpOpen(port){validatePort(port);if(connections.size>=32)throw Error('TCP preview limit');const c=sandbox.ports.connect(port),id=++connectionSequence;connections.set(id,{c,pending:new Set(),closing:false});return id},
 tcpRead(id){const e=connections.get(id);if(!e||e.closing)return new Uint8Array();return track(e,e.c.read())},
 tcpWrite(id,base64){const e=connections.get(id);if(!e||e.closing)throw Error('TCP connection is closed');const raw=atob(base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));if(bytes.length>65536)throw Error('TCP chunk exceeds limit');return track(e,e.c.write(bytes)).then(()=>bytes.length)},
 async tcpClose(id){const e=connections.get(id);if(!e||e.closing)return;e.closing=true;e.c.close();await Promise.allSettled([...e.pending]);e.c.free();connections.delete(id)},
 async http(port,url,options){validatePort(port);const r=await sandbox.ports.request(port,url,options);try{return{status:r.status,headers:r.headers,body:r.body}}finally{r.free()}},
 async kill(id){const job=jobs.get(id);if(!job)throw Error('Unknown execution job');await job.process.terminate({gracePeriodMs:500});job.ended=true;done(job,130);table()},
 async stop(){await stopJobs()},
 async exportBuild(root){if(!['dist','.next','.output'].includes(root))throw Error('Choose a build directory');const result={},todo=[root];let total=0,count=0;while(todo.length){const dir=todo.pop();for(const e of await sandbox.fs.readDir(dir)){const name=dir+'/'+e.name;if(e.kind==='directory'){if(e.name!=='cache')todo.push(name);continue}if(++count>10000)throw Error('Build export entry limit');const bytes=await sandbox.fs.readFile(name);total+=bytes.byteLength;if(total>64*1024*1024||bytes.byteLength>16*1024*1024)throw Error('Build ZIP exceeds byte budget');result['/project/'+name]=bytes}}return result},
 async shutdown(){closed=true;clearInterval(scanTimer);portStop?.();for(const pending of checkpointPending.values()){clearTimeout(pending.timer);pending.reject(Error('Runtime stopped before checkpoint commit'))}checkpointPending.clear();for(const[id]of connections)await rpc.tcpClose(id);await stopJobs();try{await client?.close()}catch{}postMessage({type:'kernel-stopped'});self.close()},
};
onmessage=({data:m})=>{
 if(globalThis.__wasmerHandleFileSystemRpc?.(m))return;
 if(m.type==='init'){initialization=initialize(m.files,m.versions,m.config,m.checkpoint);void initialization.catch(e=>send({type:'fatal',message:fail(e)}));return}
 if(m.type==='checkpoint-result'){const pending=checkpointPending.get(m.id);if(!pending)return;checkpointPending.delete(m.id);clearTimeout(pending.timer);m.error?pending.reject(Error(m.error)):pending.resolve(m.value);return}
 if(m.type==='setfiles'){writing=initialization.then(()=>fileTask(()=>putFiles(m.files,m.versions))).catch(e=>send({type:'stderr',data:'[filesystem] '+fail(e)+'\n'}));return}
 if(m.type==='cmd'){void execute(String(m.line),m.id).catch(e=>{send({type:'stderr',data:fail(e)+'\n'});send({type:'done',id:m.id,code:1});send({type:'engine-exit',code:1})});return}
 if(m.type==='input'){void foreground?.process.stdin?.write(m.data);return}if(m.type==='terminate'){void rpc.shutdown();return}
 if(m.type==='rpc'){if(!Object.prototype.hasOwnProperty.call(rpc,m.method)){send({type:'rpc-response',id:m.id,error:'Unsupported engine operation'});return}Promise.resolve().then(()=>rpc[m.method](...(m.args||[]))).then(value=>send({type:'rpc-response',id:m.id,value}),e=>send({type:'rpc-response',id:m.id,error:fail(e)}))}
};

self.addEventListener('unhandledrejection',event=>{event.preventDefault();if(!closed)send({type:'fatal',message:'Execution-group unhandled rejection: '+fail(event.reason)})});
self.addEventListener('error',event=>{event.preventDefault?.();if(!closed)send({type:'fatal',message:'Execution-group error: '+fail(event.error||event.message)})});
