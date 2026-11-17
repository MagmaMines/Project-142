'use strict';
// Namespace-local termination propagation for Node command descendants.
// SDK Process.terminate targets only the root; framework CLIs often fork servers.
const job=process.env.BEOWNIR_JOB_ID;
if(job&&/^[a-f0-9]{32}$/.test(job)){
 const fs=require('node:fs'),cp=require('node:child_process'),dir='/workspace/.beownir/jobs/'+job;
 fs.mkdirSync(dir,{recursive:true});
 function register(pid){if(Number.isInteger(pid)&&pid>0)try{fs.writeFileSync(dir+'/'+pid,'')}catch{}}
 function remove(pid){try{fs.unlinkSync(dir+'/'+pid)}catch{}}
 register(process.pid);
 const servers=new Set(),sockets=new Set(),net=require('node:net'),listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){servers.add(this);this.once('close',()=>servers.delete(this));this.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});return Reflect.apply(listen,this,args)};function closeResources(){for(const server of servers)try{if(server.listening)server.close()}catch{}for(const socket of sockets)try{socket.destroy()}catch{}}
 const children=new Set(),registered=new WeakSet(),spawn=cp.ChildProcess.prototype.spawn;
 cp.ChildProcess.prototype.spawn=function(...args){const out=Reflect.apply(spawn,this,args);const mark=()=>{if(!this.pid||registered.has(this))return;registered.add(this);children.add(this);register(this.pid);this.once('exit',()=>{children.delete(this);remove(this.pid)})};this.once('spawn',mark);mark();return out};
 function signalKnown(signal){const pids=new Set([...children].map(c=>c.pid));if(process.pid===1)try{for(const file of fs.readdirSync(dir))if(/^\d+$/.test(file))pids.add(Number(file))}catch{}for(const pid of [...pids].sort((a,b)=>b-a)){if(!pid||pid===process.pid)continue;try{process.kill(pid,signal)}catch{}}}
 let stopping=false;
 for(const signal of ['SIGTERM','SIGINT']){
  const handler=()=>{if(stopping)return;stopping=true;if(process.env.BEOWNIR_DEBUG_TREE)console.log('[tree]',process.pid,'signal',signal,'servers',servers.size,'children',children.size);const hasUserHandler=process.listenerCount(signal)>1;if(!hasUserHandler)closeResources();signalKnown(signal);const resources=setTimeout(closeResources,250);resources.unref();const hard=setTimeout(()=>signalKnown('SIGKILL'),600);hard.unref();if(process.listenerCount(signal)<=1){const exit=setTimeout(()=>process.exit(signal==='SIGINT'?130:143),800);exit.ref()}};
  process.on(signal,handler);
 }
 process.on('exit',()=>{if(process.env.BEOWNIR_DEBUG_TREE)console.log('[tree]',process.pid,'exit');closeResources();if(process.pid===1)signalKnown('SIGKILL');else for(const c of children)try{c.kill('SIGTERM')}catch{}remove(process.pid)});
 require('node:module').syncBuiltinESMExports();
}
