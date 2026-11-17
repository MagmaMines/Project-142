'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT='/workspace',registryFile=ROOT+'/.beownir/native-registry.json';
function within(root,name){if(typeof name!=='string'||name.includes('\0'))throw Error('Invalid addon path');const file=path.resolve(root,name);if(file!==root&&!file.startsWith(root+'/'))throw Error('Addon path escapes its package');return file}
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function command(program,args,cwd){return new Promise(resolve=>{let error='',child;try{child=cp.spawn(program,args,{cwd,stdio:['ignore','inherit','pipe']})}catch(e){resolve({code:1,error:e.message});return}child.stderr.on('data',chunk=>{const text=chunk.toString();process.stderr.write(text);error=(error+text).slice(-65536)});child.on('error',e=>resolve({code:1,error:e.message}));child.on('close',code=>resolve({code:code??1,error}))})}
async function build(cwd=ROOT){
 const manifest=JSON.parse(fs.readFileSync(path.join(cwd,'package.json'),'utf8')),definitions=manifest.beownir?.nativeAddons||{};
 let registry={};try{registry=JSON.parse(fs.readFileSync(registryFile,'utf8'))}catch{}
 const results=[];fs.mkdirSync(ROOT+'/.beownir/addons-cache',{recursive:true});
 for(const[name,description]of Object.entries(definitions)){
  const d=description||{},request=within(cwd,name);if(!request.endsWith('.node'))throw Error('Declare the requested .node filename as the nativeAddons key');
  const exports=Array.isArray(d.exports)?d.exports:[];if(exports.length>256||exports.some(x=>typeof x!=='string'||!/^[A-Za-z_$][\w$]*$/.test(x)))throw Error('Invalid C/WASM export list');
  const sources=(d.sources||[]).map(x=>within(cwd,x));if(sources.length>64||sources.some(x=>!(/\.(?:c|cc|cpp|cxx)$/.test(x))))throw Error('Unsupported source list');
  const key=digest(JSON.stringify({name,sources:sources.map(x=>[x,fs.existsSync(x)?fs.readFileSync(x,'utf8'):null]),exports,flags:d.flags||[]})),output=ROOT+'/.beownir/addons-cache/'+key+'.wasm';let selected,error;
  if(d.wasm&&fs.existsSync(within(cwd,d.wasm))){fs.copyFileSync(within(cwd,d.wasm),output);selected='wasm';}
  else if(sources.length){
   const flags=d.flags||[];if(!Array.isArray(flags)||flags.length>64||flags.some(x=>typeof x!=='string'||x.includes('\0')||!/^-(?:O[0-3sz]|g\d*|std=[\w+.-]+|D[^\s]+|I[^\s]+|W[\w,=+-]+)$/.test(x)))throw Error('Unsafe or unsupported compiler flag; use declared source/include paths');
   console.log('[native] Compiling '+name+' to WASI in the browser');
   let result;
   if(d.libc){const args=['--target=wasm32-wasi','-mexec-model=reactor','-O2',...flags,...sources,...exports.map(x=>'-Wl,--export='+x),'-Wl,--export-memory','-o',output];result=await command(d.cxx?'clang++':'clang',args,cwd)}
   else{
    // This Clang distribution requires a signal trampoline export even for
    // -nostdlib libraries. A freestanding addon has no process-signal ABI:
    // make unsupported signal delivery trap explicitly instead of pretending
    // that a signal handler exists or linking a WASIX process libc.
    const runtime=output+'.runtime.c';fs.writeFileSync(runtime,'__attribute__((noreturn)) void __wasm_signal(int signal) { __builtin_trap(); }\n');
    result=await command(d.cxx?'clang++':'clang',['--target=wasm32-wasi','-nostdlib','-O2',...flags,...sources,runtime,'-Wl,--no-entry',...exports.map(x=>'-Wl,--export='+x),'-Wl,--export-memory','-o',output],cwd);
   }
   if(result.code===0)selected='wasm';else error=result.error||'Compiler/linker exit '+result.code;
  }
  if(selected==='wasm'){
   try{const bytes=fs.readFileSync(output),module=new WebAssembly.Module(bytes),names=new Set(WebAssembly.Module.exports(module).map(x=>x.name));for(const imported of WebAssembly.Module.imports(module))if(imported.module!=='wasi_snapshot_preview1'&&!(imported.module==='env'&&imported.name==='memory'&&imported.kind==='memory'))throw Error('Unsupported compiled addon ABI import '+imported.module+'.'+imported.name);for(const name of exports)if(!names.has(name))throw Error('Compiled module is missing '+name);registry[request]={type:'wasm-cabi',wasm:output,sha256:digest(bytes),exports,adapter:d.adapter?within(cwd,d.adapter):null,preopens:d.preopens===true?cwd:null};results.push({request,implementation:'WASM',compiled:sources.length>0,sha256:registry[request].sha256})}catch(e){selected=null;error=e.message}
  }
  if(!selected){
   if(d.fallback){let fallback;if(d.fallback.startsWith('.'))fallback=within(cwd,d.fallback);else fallback=require.resolve(d.fallback,{paths:[cwd]});if(!fs.existsSync(fallback))throw Error('JS fallback is missing: '+fallback);registry[request]={type:'js',fallback};results.push({request,implementation:'JavaScript fallback',compilerError:error||'No compatible WASM/source build was supplied'})}
   else throw Error('Cannot build '+name+': '+(error||'No WASM/source or JS fallback declared')+'. V8/NAN and arbitrary native libraries are not automatically portable.');
  }
  fs.mkdirSync(path.dirname(request),{recursive:true});if(!fs.existsSync(request))fs.writeFileSync(request,'BEOWNIR_PORTABLE_ADDON_V1\n');
 }
 fs.writeFileSync(registryFile,JSON.stringify(registry,null,2)+'\n');console.log('[native] '+JSON.stringify(results));return results;
}
module.exports={build};
