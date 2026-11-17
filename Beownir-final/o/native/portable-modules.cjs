'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const ROOT='/workspace',registryFile=ROOT+'/.beownir/native-registry.json';
function memoryDescriptor(bytes,moduleName,fieldName){
 let offset=8;const number=()=>{let value=0,shift=0;for(let n=0;n<5;n++){if(offset>=bytes.length)throw Error('Invalid WASM LEB');const b=bytes[offset++];value+=(b&127)*2**shift;if(!(b&128))return value;shift+=7}throw Error('WASM integer exceeds wasm32')};const text=()=>{const n=number(),end=offset+n;if(end>bytes.length)throw Error('Invalid WASM string');const value=Buffer.from(bytes.subarray(offset,end)).toString('utf8');offset=end;return value};
 function limits(){const flags=number(),initial=number(),maximum=flags&1?number():undefined;return{flags,initial,maximum}}
 while(offset<bytes.length){const kind=bytes[offset++],size=number(),end=offset+size;if(end>bytes.length)throw Error('Invalid WASM section');if(kind===2){const count=number();for(let n=0;n<count;n++){const owner=text(),name=text(),type=bytes[offset++];if(type===0)number();else if(type===1){offset++;limits()}else if(type===2){const value=limits();if(owner===moduleName&&name===fieldName){if(value.flags&4)throw Error('memory64 addons need a separate ABI');if(value.initial>4096)throw Error('Addon initial memory exceeds 256 MiB budget');return{initial:value.initial,maximum:Math.max(value.initial,Math.min(value.maximum??4096,4096)),shared:Boolean(value.flags&2)}}}else if(type===3)offset+=2;else if(type===4){offset++;number()}else throw Error('Unknown WASM import kind')}}offset=end}
 throw Error('Missing WASM memory import descriptor');
}
const originalNode=Module._extensions['.node'];
Module._extensions['.node']=function(module,filename){
 let entry;try{entry=JSON.parse(fs.readFileSync(registryFile,'utf8'))[filename]}catch{}
 if(!entry){try{return originalNode(module,filename)}catch(error){error.message+='\nThis browser runtime cannot load arbitrary machine-code addons. Use package WASM/JS builds or declare beownir.nativeAddons and run beownir native-build.';throw error}}
 if(entry.type==='js'){module.exports=Module._load(entry.fallback,module,false);return}
 if(entry.type!=='wasm-cabi')throw Error('Unknown portable addon ABI');
 const bytes=fs.readFileSync(entry.wasm);if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Portable addon integrity mismatch');
 const compiled=new WebAssembly.Module(bytes),imports={};let wasi;
 for(const imported of WebAssembly.Module.imports(compiled)){if(imported.module==='env'&&imported.name==='memory'&&imported.kind==='memory'){imports.env??={};imports.env.memory=new WebAssembly.Memory(memoryDescriptor(bytes,'env','memory'));continue}if(imported.module!=='wasi_snapshot_preview1')throw Error('Unsupported C/WASM addon import: '+imported.module+'.'+imported.name);if(!wasi){const{WASI}=require('node:wasi');wasi=new WASI({version:'preview1',args:[],env:{},preopens:entry.preopens?{'/workspace':entry.preopens}:{}});imports.wasi_snapshot_preview1=wasi.wasiImport}}
 const instance=new WebAssembly.Instance(compiled,imports);if(wasi)wasi.initialize(instance);const result={};for(const name of entry.exports||[])result[name]=instance.exports[name];if(instance.exports.memory)Object.defineProperty(result,'memory',{value:instance.exports.memory});
 module.exports=entry.adapter?Module._load(entry.adapter,module,false)(result):result;
};
// Browser-target module mapping is opt-in. Server code keeps Node semantics.
// Frontend bundlers already handle exports/browser fields; no keyword substitution.
if(process.env.BEOWNIR_MODULE_TARGET==='browser'){
 const resolve=Module._resolveFilename,load=Module._load,empty='beownir:browser-empty';const emptyModule=Object.freeze({});
 function packageRoot(filename){let dir=path.dirname(filename||path.join(process.cwd(),'index.js'));while(dir.startsWith(ROOT)){const file=path.join(dir,'package.json');if(fs.existsSync(file))return{dir,data:JSON.parse(fs.readFileSync(file,'utf8'))};const parent=path.dirname(dir);if(parent===dir)break;dir=parent}return null}
 Module._resolveFilename=function(request,parent,...args){const pkg=packageRoot(parent?.filename);if(pkg&&pkg.data.browser&&typeof pkg.data.browser==='object'){let key=request;if(request.startsWith('.'))key='./'+path.relative(pkg.dir,path.resolve(path.dirname(parent.filename),request)).replaceAll(path.sep,'/');let value=pkg.data.browser[key];if(value===undefined)value=pkg.data.browser[key+'.js'];if(value===false)return empty;if(typeof value==='string')request=value.startsWith('.')?path.resolve(pkg.dir,value):value}return Reflect.apply(resolve,this,[request,parent,...args])};
 Module._load=function(request,parent,isMain){if(request===empty)return emptyModule;const resolved=Module._resolveFilename(request,parent,isMain);if(resolved===empty)return emptyModule;return Reflect.apply(load,this,[resolved,parent,isMain])};
}
Module.syncBuiltinESMExports();
