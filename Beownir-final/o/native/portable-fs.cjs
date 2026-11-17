'use strict';
// Implement directory helpers with real Node fs syscalls. The WASIX backend's
// native cp/rm helpers are incomplete (rmSync could return success without removal).
const fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url');
const filename=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():String(value);
const error=(code,message,src,dest)=>Object.assign(new Error(message),{code,path:src,dest});
function rmSync(input,options={}){
 const target=filename(input);let stat;try{stat=fs.lstatSync(target)}catch(e){if(options.force&&e.code==='ENOENT')return;throw e}
 if(stat.isDirectory()&&!stat.isSymbolicLink()){
  if(!options.recursive)throw error('ERR_FS_EISDIR','Path is a directory: '+target,target);
  for(const child of fs.readdirSync(target))rmSync(path.join(target,child),{...options,force:true});
  fs.rmdirSync(target);
 }else fs.unlinkSync(target);
}
function cpSync(source,destination,options={}){
 source=path.resolve(filename(source));destination=path.resolve(filename(destination));
 if(destination===source||destination.startsWith(source+path.sep))throw error('ERR_FS_CP_EINVAL','Cannot copy a path into itself',source,destination);
 const copy=(src,dest)=>{
  if(options.filter){const yes=options.filter(src,dest);if(yes&&typeof yes.then==='function')throw error('ERR_INVALID_RETURN_VALUE','cpSync filter must return a boolean',src,dest);if(!yes)return}
  const stat=options.dereference?fs.statSync(src):fs.lstatSync(src);let existing;try{existing=fs.lstatSync(dest)}catch(e){if(e.code!=='ENOENT')throw e}
  if(stat.isDirectory()){
   if(!options.recursive)throw error('ERR_FS_EISDIR','Recursive copy requires recursive:true',src,dest);
   if(existing&&!existing.isDirectory())throw error('ERR_FS_CP_DIR_TO_NON_DIR','Directory destination is not a directory',src,dest);
   fs.mkdirSync(dest,{recursive:true,mode:stat.mode});for(const child of fs.readdirSync(src))copy(path.join(src,child),path.join(dest,child));
  }else{
   if(existing){if(existing.isDirectory())throw error('ERR_FS_CP_NON_DIR_TO_DIR','File destination is a directory',src,dest);if(options.force===false){if(options.errorOnExist)throw error('ERR_FS_CP_EEXIST','Destination exists',src,dest);return}fs.unlinkSync(dest)}
   fs.mkdirSync(path.dirname(dest),{recursive:true});
   if(stat.isSymbolicLink()){const link=fs.readlinkSync(src);fs.symlinkSync(options.verbatimSymlinks?link:path.resolve(path.dirname(src),link),dest)}else if(stat.isFile())fs.copyFileSync(src,dest,options.mode||0);else throw error('ERR_FS_CP_UNKNOWN','Unsupported file type',src,dest);
  }
  if(options.preserveTimestamps&&!stat.isSymbolicLink())fs.utimesSync(dest,stat.atime,stat.mtime);
 };
 copy(source,destination);
}
const contextual=(fn,callback)=>{const context=globalThis.__beownirAsyncContext,frame=context?.capture();process.nextTick(()=>{try{fn();context?context.run(frame,callback,undefined,[null]):callback(null)}catch(e){context?context.run(frame,callback,undefined,[e]):callback(e)}})};
fs.rmSync=rmSync;fs.rm=function(target,options,callback){if(typeof options==='function'){callback=options;options={}}if(typeof callback!=='function')throw new TypeError('Callback is required');contextual(()=>rmSync(target,options),callback)};
fs.cpSync=cpSync;fs.cp=function(src,dest,options,callback){if(typeof options==='function'){callback=options;options={}}if(typeof callback!=='function')throw new TypeError('Callback is required');contextual(()=>cpSync(src,dest,options),callback)};
fs.promises.rm=async(target,options)=>rmSync(target,options);fs.promises.cp=async(src,dest,options)=>cpSync(src,dest,options);
require('node:module').syncBuiltinESMExports();
// Journal cache-tree mutations across all Node descendants. The isolated engine
// checkpoints only after a successful job, never trusting partial installs.
const root='/workspace',nativeWriteFileSync=fs.writeFileSync;
function dirty(value){try{if(typeof value==='number'||value==null)return;const name=path.resolve(filename(value)),relative=path.relative(root,name);if(relative.startsWith('..')||path.isAbsolute(relative))return;const parts=relative.split(path.sep);if(parts.includes('node_modules')||['dist','.next','.output'].includes(parts[0])||relative.startsWith('.beownir/addons-cache')||relative==='.beownir/native-registry.json')Reflect.apply(nativeWriteFileSync,fs,[root+'/.beownir/cache-dirty','1'])}catch{}}
for(const key of ['writeFile','writeFileSync','appendFile','appendFileSync','mkdir','mkdirSync','rmdir','rmdirSync','rm','rmSync','unlink','unlinkSync','truncate','truncateSync','chmod','chmodSync','utimes','utimesSync','copyFile','copyFileSync','cp','cpSync','rename','renameSync','link','linkSync','symlink','symlinkSync']){const original=fs[key];if(typeof original!=='function')continue;fs[key]=function(...args){dirty(args[0]);if(/^(?:copyFile|cp|rename|link|symlink)/.test(key))dirty(args[1]);return Reflect.apply(original,this,args)}}
for(const key of ['writeFile','appendFile','mkdir','rmdir','rm','unlink','truncate','chmod','utimes','copyFile','cp','rename','link','symlink']){const original=fs.promises[key];if(typeof original!=='function')continue;fs.promises[key]=function(...args){dirty(args[0]);if(/^(?:copyFile|cp|rename|link|symlink)/.test(key))dirty(args[1]);return Reflect.apply(original,this,args)}}
const writable=flags=>typeof flags==='string'?/[wa+]/.test(flags):typeof flags==='number'&&Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
for(const key of ['open','openSync']){const original=fs[key];fs[key]=function(...args){if(writable(args[1]))dirty(args[0]);return Reflect.apply(original,this,args)}}
const openPromise=fs.promises.open;fs.promises.open=function(...args){if(writable(args[1]))dirty(args[0]);return Reflect.apply(openPromise,this,args)};
const createWriteStream=fs.createWriteStream;fs.createWriteStream=function(...args){dirty(args[0]);return Reflect.apply(createWriteStream,this,args)};
// A bounded install-only filesystem counter makes the expensive post-download
// materialization phase observable in browser WASIX. It is off for normal
// commands and counts operations only; it never walks the package tree or
// writes a second diagnostic file during an install.
if(process.env.BEOWNIR_INSTALL_DIAGNOSTICS==='1'){
 const metrics={started:Date.now(),operations:0,writes:0,reads:0,links:0,removes:0,errors:0};
 const groups={writes:new Set(['writeFile','writeFileSync','appendFile','appendFileSync','copyFile','copyFileSync','cp','cpSync','rename','renameSync','mkdir','mkdirSync','chmod','chmodSync','utimes','utimesSync','truncate','truncateSync']),reads:new Set(['readFile','readFileSync','readdir','readdirSync','stat','statSync','lstat','lstatSync','realpath','realpathSync','access','accessSync','open','openSync']),links:new Set(['link','linkSync','symlink','symlinkSync']),removes:new Set(['rm','rmSync','rmdir','rmdirSync','unlink','unlinkSync'])};
 const marker=(name,args)=>{if(metrics.operations!==1&&(metrics.operations&(metrics.operations-1))!==0)return;try{let target=typeof args[0]==='string'?args[0]:args[0]?.path||'';target=String(target).replace(/^\/workspace\/?/,'').slice(-180);console.error('[beownir-fs] marker ops='+metrics.operations+' operation='+name+(target?' path='+target:''))}catch{}};
 const mark=(name,args)=>{metrics.operations++;for(const[group,names]of Object.entries(groups))if(names.has(name)){metrics[group]++;break}marker(name,args)};
 for(const name of new Set(Object.values(groups).flatMap(set=>[...set]))){const original=fs[name];if(typeof original!=='function')continue;const wrapped=function(...args){mark(name,args);try{return Reflect.apply(original,this,args)}catch(error){metrics.errors++;throw error}};Object.assign(wrapped,original);fs[name]=wrapped}
 for(const name of ['writeFile','appendFile','copyFile','cp','rename','mkdir','chmod','utimes','truncate','readFile','readdir','stat','lstat','realpath','access','open','rm','rmdir','unlink','link','symlink']){const original=fs.promises[name];if(typeof original!=='function')continue;const wrapped=function(...args){mark(name,args);try{const result=Reflect.apply(original,this,args);return Promise.resolve(result).catch(error=>{metrics.errors++;throw error})}catch(error){metrics.errors++;throw error}};Object.assign(wrapped,original);fs.promises[name]=wrapped}
 const report=final=>{try{const elapsed=((Date.now()-metrics.started)/1000).toFixed(1),memory=process.memoryUsage?.().rss;console.error('[beownir-fs]'+(final?' final':'')+' elapsed='+elapsed+'s ops='+metrics.operations+' write='+metrics.writes+' read='+metrics.reads+' link='+metrics.links+' remove='+metrics.removes+' errors='+metrics.errors+(memory?' rss='+Math.round(memory/1024/1024)+'MiB':''))}catch{}};
 const timer=setInterval(()=>report(false),15000);timer.unref?.();process.once('exit',()=>report(true));
}
require('node:module').syncBuiltinESMExports();
