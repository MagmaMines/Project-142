// Route synchronous guest requests to the non-blocked engine Worker. Every
// spawned command still executes in browser WASIX, never in the Node host.
const marker=Symbol.for('beownir.worker.syscalls');
export function installSyscallBroker(handle){
 if(globalThis.Worker?.[marker])return;
 const NativeWorker=globalThis.Worker;if(typeof NativeWorker!=='function')return;
 class RoutedWorker extends NativeWorker{
  constructor(...args){super(...args);this.addEventListener('message',event=>{const request=event.data;if(request?.type!=='beownir-node-syscall')return;event.stopImmediatePropagation();if(handle)void Promise.resolve().then(()=>handle(request)).catch(error=>replySyscall(request,{error:{message:error.message,code:error.code||'EIO'}}));else globalThis.postMessage(request)})}
 }
 Object.defineProperty(RoutedWorker,marker,{value:true});globalThis.Worker=RoutedWorker;
}
export function replySyscall(request,result){
 const control=new Int32Array(request.response,0,8),payload=new Uint8Array(request.response,32);let out=result.stdout||new Uint8Array(),err=result.stderr||new Uint8Array(),meta=new TextEncoder().encode(JSON.stringify(result.error||null));
 if(out.byteLength+err.byteLength+meta.byteLength>payload.byteLength){out=new Uint8Array();err=new Uint8Array();meta=new TextEncoder().encode(JSON.stringify({message:'Synchronous subprocess output exceeded its mailbox',code:'ENOBUFS'}))}
 payload.set(out,0);payload.set(err,out.byteLength);payload.set(meta,out.byteLength+err.byteLength);control[1]=result.status??-1;control[2]=out.byteLength;control[3]=err.byteLength;control[4]=result.pid||0;control[5]=meta.byteLength;control[6]=result.signal==='SIGTERM'?15:result.signal==='SIGKILL'?9:0;Atomics.store(control,0,1);Atomics.notify(control,0);
}
