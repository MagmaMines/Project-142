'use strict';
const cp=require('node:child_process'),{fileURLToPath}=require('node:url');
function spawnSync(file,args,options){
 if(!Array.isArray(args)){options=args||{};args=[]}options=options||{};
 if(typeof file!=='string'||!file||args.some(x=>typeof x!=='string'))throw new TypeError('Synchronous spawn requires a program and string arguments');
 const maxBuffer=options.maxBuffer===undefined?1024*1024:Number(options.maxBuffer);if(!Number.isFinite(maxBuffer)||maxBuffer<1||maxBuffer>32*1024*1024)throw new RangeError('maxBuffer must be 1–33554432 bytes');
 const cwd=options.cwd instanceof URL?fileURLToPath(options.cwd):options.cwd||process.cwd(),env={...(options.env||process.env)};
 let program=file,argv=[...args];if(options.shell){program=typeof options.shell==='string'?options.shell:'sh';argv=['-c',file+(args.length?' '+args.join(' '):'')]}
 const input=options.input==null?new Uint8Array():typeof options.input==='string'?Buffer.from(options.input,options.encoding&&options.encoding!=='buffer'?options.encoding:'utf8'):ArrayBuffer.isView(options.input)?new Uint8Array(options.input.buffer,options.input.byteOffset,options.input.byteLength):options.input instanceof ArrayBuffer||(typeof SharedArrayBuffer!=='undefined'&&options.input instanceof SharedArrayBuffer)?new Uint8Array(options.input):Buffer.from(String(options.input),options.encoding&&options.encoding!=='buffer'?options.encoding:'utf8');
 const result=globalThis.__beownirSyscallSync({kind:'spawnSync',file:program,args:argv,cwd,env,input,maxBuffer,timeout:Number(options.timeout)||0});
 const decode=bytes=>options.encoding&&options.encoding!=='buffer'?Buffer.from(bytes).toString(options.encoding):Buffer.from(bytes);
 const out={pid:result.pid,status:result.status,signal:result.signal||null,stdout:decode(result.stdout),stderr:decode(result.stderr)};out.output=[null,out.stdout,out.stderr];
 if(result.error)out.error=Object.assign(new Error(result.error.message),result.error,{spawnargs:argv,path:file});
 const stdio=options.stdio;if(stdio==='inherit'||Array.isArray(stdio)&&stdio[1]==='inherit')process.stdout.write(result.stdout);if(stdio==='inherit'||Array.isArray(stdio)&&stdio[2]==='inherit')process.stderr.write(result.stderr);return out;
}
function execFileSync(file,args,options){if(!Array.isArray(args)){options=args||{};args=[]}const result=spawnSync(file,args,options);if(result.error||result.status!==0){const error=result.error||new Error('Command failed: '+file+(args.length?' '+args.join(' '):'')+'\n'+result.stderr);Object.assign(error,result);throw error}return result.stdout}
cp.spawnSync=spawnSync;cp.execFileSync=execFileSync;cp.execSync=(command,options={})=>execFileSync(typeof options.shell==='string'?options.shell:'sh',['-c',command],{...options,shell:false});
require('node:module').syncBuiltinESMExports();
