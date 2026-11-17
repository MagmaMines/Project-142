'use strict';
// libuv fs-poll is unavailable in this browser backend. Use real JS polling.
const fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url'),{EventEmitter}=require('node:events');
if(process.platform==='wasi'){
 const watchers=new Map();
 const filename=value=>path.resolve(value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value);
 function snapshot(file,bigint){try{const stat=fs.statSync(file,{bigint});return{stat,key:[stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino,stat.mode].join(':')}}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e;const zero=bigint?0n:0;return{stat:{size:zero,mtimeMs:zero,ctimeMs:zero,ino:zero,mode:zero,nlink:zero,mtime:new Date(0),ctime:new Date(0),isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>false},key:'missing'}}}
 class PollWatcher extends EventEmitter{
  constructor(file,options){super();this.file=file;this.options=options;this.previous=snapshot(file,options.bigint);this.timer=setInterval(()=>this.poll(),Math.max(100,Number(options.interval)||500));if(options.persistent===false)this.timer.unref()}
  poll(){let next;try{next=snapshot(this.file,this.options.bigint)}catch(e){this.emit('error',e);return}if(next.key!==this.previous.key){const previous=this.previous;this.previous=next;this.emit('change',next.stat,previous.stat)}}
  stop(){clearInterval(this.timer);watchers.delete(this.file);this.emit('stop')}
  ref(){this.timer.ref();return this}unref(){this.timer.unref();return this}
 }
 fs.watchFile=function(file,options,listener){if(typeof options==='function'){listener=options;options={}}options=options||{};if(typeof listener!=='function')throw new TypeError('watchFile requires a listener');file=filename(file);let watcher=watchers.get(file);if(!watcher){watcher=new PollWatcher(file,options);watchers.set(file,watcher)}watcher.on('change',listener);return watcher};
 fs.unwatchFile=function(file,listener){file=filename(file);const watcher=watchers.get(file);if(!watcher)return;if(listener)watcher.removeListener('change',listener);else watcher.removeAllListeners('change');if(!watcher.listenerCount('change'))watcher.stop()};
 require('node:module').syncBuiltinESMExports();
}
