'use strict';
const context=globalThis.__beownirAsyncContext;
if(!context)throw Error('Portable async context requires the patched browser execution core');
const hooks=require('node:async_hooks'),AsyncLocalStorage=hooks.AsyncLocalStorage;
const originalGetStore=AsyncLocalStorage.prototype.getStore,originalRun=AsyncLocalStorage.prototype.run,originalEnter=AsyncLocalStorage.prototype.enterWith,originalExit=AsyncLocalStorage.prototype.exit,originalDisable=AsyncLocalStorage.prototype.disable,nativeBind=AsyncLocalStorage.bind,nativeSnapshot=AsyncLocalStorage.snapshot,metadata=new WeakMap();
function state(instance){let value=metadata.get(instance);if(!value){value={generation:0,defaultValue:Reflect.apply(originalGetStore,instance,[])};metadata.set(instance,value)}return value}
const methods={
 getStore(){const data=state(this),entry=context.get(this);return entry&&entry.generation===data.generation?entry.value:(Reflect.apply(originalGetStore,this,[])??data.defaultValue)},
 run(store,callback,...args){const instance=this,entry={generation:state(this).generation,value:store};return Reflect.apply(originalRun,this,[store,function(...values){return context.withValue(instance,entry,callback,this,values)},...args])},
 enterWith(store){Reflect.apply(originalEnter,this,[store]);context.enter(this,{generation:state(this).generation,value:store})},
 exit(callback,...args){const instance=this;return Reflect.apply(originalExit,this,[function(...values){return context.without(instance,callback,this,values)},...args])},
 disable(){state(this).generation++;return Reflect.apply(originalDisable,this,[])},
};
for(const[key,value]of Object.entries(methods))Object.defineProperty(AsyncLocalStorage.prototype,key,{value,writable:true,configurable:true});
Object.defineProperties(AsyncLocalStorage,{bind:{value:fn=>Reflect.apply(nativeBind,AsyncLocalStorage,[context.wrap(fn)]),writable:true,configurable:true},snapshot:{value:()=>{const frame=context.capture(),runNative=Reflect.apply(nativeSnapshot,AsyncLocalStorage,[]);return function(fn,...args){const receiver=this;return runNative(()=>context.run(frame,fn,receiver,args))}},writable:true,configurable:true}});
globalThis.AsyncLocalStorage=AsyncLocalStorage;
// VM contexts are created by this backend from the worker's intrinsic facade.
// Publish the process-owned class there so React's VM bundles see the same ALS.
Function.prototype.constructor('return globalThis')().AsyncLocalStorage=AsyncLocalStorage;
if(typeof context.set==='function'){const frames=new Map(),stack=[],empty=new Map();hooks.createHook({init(id){frames.set(id,context.capture())},before(id){stack.push(context.capture());context.set(frames.get(id)||empty)},after(){if(stack.length)context.set(stack.pop())},destroy(id){frames.delete(id)}}).enable();}

const marker=Symbol.for('beownir.contextual-callbacks.v2');
const proto=Promise.prototype;
if(!proto[marker]){const nativeThen=proto.then;Object.defineProperty(proto,marker,{value:true});proto.then=function(fulfilled,rejected){return Reflect.apply(nativeThen,this,[context.wrap(fulfilled),context.wrap(rejected)])}}
for(const key of ['setTimeout','setInterval','setImmediate','queueMicrotask']){const native=globalThis[key];if(typeof native==='function'&&!native[marker]){const replacement=function(callback,...args){return Reflect.apply(native,this,[context.wrap(callback),...args])};Object.defineProperty(replacement,marker,{value:true});globalThis[key]=replacement;}}
const nativeTick=process.nextTick;process.nextTick=function(callback,...args){return Reflect.apply(nativeTick,process,[context.wrap(callback),...args])};
const timers=require('node:timers');for(const key of ['setTimeout','setInterval','setImmediate'])if(typeof globalThis[key]==='function')timers[key]=globalThis[key];
const fs=require('node:fs');for(const key of ['access','appendFile','chmod','chown','close','copyFile','cp','exists','fchmod','fchown','fdatasync','fstat','fsync','ftruncate','futimes','lchown','link','lstat','lutimes','mkdir','mkdtemp','open','opendir','read','readFile','readdir','readlink','readv','realpath','rename','rm','rmdir','stat','statfs','symlink','truncate','unlink','utimes','write','writeFile','writev']){const native=fs[key];if(typeof native!=='function')continue;const wrapper=function(...args){const last=args.length-1;if(typeof args[last]==='function')args[last]=context.wrap(args[last]);return Reflect.apply(native,this,args)};Object.defineProperties(wrapper,Object.getOwnPropertyDescriptors(native));fs[key]=wrapper}
require('node:module').syncBuiltinESMExports();
