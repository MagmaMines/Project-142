'use strict';
// Package-specific alternatives, never lexical replacement of Node keywords.
const fs=require('node:fs'),path=require('node:path');
const catalogue=Object.freeze({
 esbuild:{wasm:'esbuild-wasm',sameVersion:true,note:'Official esbuild WASM API'},
 rollup:{wasm:'@rollup/wasm-node',sameVersion:true,note:'Official Rollup WASM Node build'},
 '@swc/core':{wasm:'@swc/wasm',sameVersion:true,note:'SWC WASM; native plugins still require compatible WASM plugins'},
 '@parcel/watcher':{wasm:'@parcel/watcher-wasm',sameVersion:true,note:'Official WASM watcher'},
 bcrypt:{js:'bcryptjs',version:'3.0.3',note:'JS bcrypt implementation; performance differs'},
 lightningcss:{wasm:'lightningcss-wasm',sameVersion:true,note:'Official Lightning CSS WASM build'},
 'node-sass':{js:'sass',version:'1.106.1',note:'Dart Sass legacy JS API; LibSass/Dart Sass language differences apply'}
});
const versions=new Map();
async function metadata(name,spec='latest'){
 const key=name+'@'+spec;if(versions.has(key))return versions.get(key);
 const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(name),{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Package metadata '+name+': HTTP '+response.status);
 const all=await response.json();let version=all['dist-tags']?.[spec];if(!version){const semver=require('./semver.cjs');version=semver.maxSatisfying(Object.keys(all.versions||{}),spec)}if(!version||!all.versions[version])throw Error('No compatible published '+name+' version for '+spec);const value=all.versions[version];versions.set(key,value);return value;
}
const portableSpec=(name,spec)=>{const item=Object.hasOwn(catalogue,name)?catalogue[name]:null;if(!item||typeof spec!=='string'||/^(?:npm:|workspace:|file:|link:|https?:|git)/.test(spec))return null;return'npm:'+(item.wasm||item.js)+'@'+(item.sameVersion?spec:item.version)};
function splitSpec(value){if(typeof value!=='string'||value.startsWith('-')||/^(?:file:|https?:|git|\.\/|\.\.\/|\/)/.test(value))return null;const at=value.lastIndexOf('@');if(at>0)return{name:value.slice(0,at),version:value.slice(at+1)||'latest'};return{name:value,version:'latest'}}
function rootManifest(cwd){const file=path.join(cwd,'package.json');if(!fs.existsSync(file))return{file,data:{name:'browser-workspace',version:'1.0.0',private:true}};return{file,data:JSON.parse(fs.readFileSync(file,'utf8'))}}
async function prepare(cwd,args,manager){
 const {file,data}=rootManifest(cwd),changes=[];const original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
 const action=args[0]||'install',ci=action==='ci',requested=[];
 if(['install','i','add'].includes(action)){let skip=false;for(let i=1;i<args.length;i++){const arg=args[i];if(skip){skip=false;continue}if(['--prefix','--registry','--cache','--workspace','-w','--filter'].includes(arg)){skip=true;continue}const item=splitSpec(arg);if(item)requested.push({index:i,...item})}}
 for(const section of ['dependencies','devDependencies','optionalDependencies'])for(const[name,range]of Object.entries(data[section]||{})){const alternative=portableSpec(name,range);if(alternative){data[section][name]=alternative;changes.push({package:name,from:range,to:alternative,type:catalogue[name].wasm?'package WASM':'JS fallback'})}}
 // Framework transitive defaults, while keeping actual frameworks unmodified.
 const dependencies={...data.dependencies,...data.devDependencies,...data.optionalDependencies};
 if(dependencies.vite&&(!data.overrides?.esbuild||!data.overrides?.rollup)&&!/^(?:file:|workspace:|npm:|git|https?:)/.test(dependencies.vite)){
  const vite=await metadata('vite',dependencies.vite);for(const name of ['esbuild','rollup'])if(vite.dependencies?.[name]){data.overrides??={};data.pnpm??={};data.pnpm.overrides??={};const spec=portableSpec(name,vite.dependencies[name]);if(spec&&!data.overrides[name]){data.overrides[name]=spec;data.pnpm.overrides[name]=spec;changes.push({package:name,to:spec,type:'transitive WASM'})}}
 }
 if(dependencies.next&&!data.dependencies?.['@next/swc-wasm-nodejs']&&!/^(?:file:|workspace:|npm:|git|https?:)/.test(dependencies.next)){
  const next=await metadata('next',dependencies.next);data.dependencies??={};if(!data.dependencies['@next/swc-wasm-nodejs']){data.dependencies['@next/swc-wasm-nodejs']=next.version;changes.push({package:'@next/swc-wasm-nodejs',to:next.version,type:'Next official WASM compiler'})}
 }
 const extra=[];
 if(dependencies.sharp&&!data.dependencies?.['@img/sharp-wasm32']&&!/^(?:file:|workspace:|npm:|git|https?:)/.test(dependencies.sharp)){const sharp=await metadata('sharp',dependencies.sharp);data.dependencies??={};if(!data.dependencies['@img/sharp-wasm32']){data.dependencies['@img/sharp-wasm32']=sharp.version;changes.push({package:'@img/sharp-wasm32',to:sharp.version,type:'official libvips WASM'})}}
 for(const item of requested){const alternative=portableSpec(item.name,item.version);if(alternative){args[item.index]=item.name+'@'+alternative;changes.push({package:item.name,from:item.version,to:alternative,type:catalogue[item.name].wasm?'package WASM':'JS fallback'})}else if(item.name==='vite'){const vite=await metadata('vite',item.version);data.overrides??={};data.pnpm??={};data.pnpm.overrides??={};for(const name of ['esbuild','rollup']){const spec=portableSpec(name,vite.dependencies?.[name]||'*');if(!data.overrides[name]){data.overrides[name]=spec;data.pnpm.overrides[name]=spec;changes.push({package:name,to:spec,type:'transitive WASM'})}}}else if(item.name==='next'||item.name==='sharp'){const pkg=await metadata(item.name,item.version),name=item.name==='next'?'@next/swc-wasm-nodejs':'@img/sharp-wasm32';extra.push(name+'@'+pkg.version);changes.push({package:name,to:pkg.version,type:'official WASM companion'})}}
 for(const item of extra)args.push(item);
 // npm disallows a mismatched direct dependency override; reference its spec.
 if(manager==='npm')for(const[name,range]of Object.entries(data.overrides||{}))if(typeof range==='string'&&dependencies[name]&&data.dependencies?.[name]===range)data.overrides[name]='$'+name;
 const changed=JSON.stringify(data)!==JSON.stringify(original?JSON.parse(original):{});
 if(ci&&changed)throw Error('npm ci will not mutate a manifest/lockfile. Run npm install once to record portable alternatives, then npm ci.');
 if(changed&&!ci)fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
 return{changes,file,original,args};
}
function findPackages(cwd='/workspace'){
 const found=[],seen=new Set();function walkModules(dir,depth){if(depth>18||!fs.existsSync(dir))return;for(const name of fs.readdirSync(dir)){if(name==='.bin'||name.startsWith('.')&&name!=='.pnpm')continue;const p=path.join(dir,name);let stat;try{stat=fs.statSync(p)}catch{continue}if(!stat.isDirectory())continue;if(name==='.pnpm'){for(const store of fs.readdirSync(p))walkModules(path.join(p,store,'node_modules'),depth+1);continue}if(name.startsWith('@')){walkModules(p,depth+1);continue}let real;try{real=fs.realpathSync(p)}catch{continue}if(seen.has(real))continue;seen.add(real);const manifest=path.join(real,'package.json');if(fs.existsSync(manifest)){try{found.push({root:real,manifest:JSON.parse(fs.readFileSync(manifest,'utf8'))})}catch{}}walkModules(path.join(real,'node_modules'),depth+1)}}walkModules(path.join(cwd,'node_modules'),0);return found;
}
function fixup(cwd){const actions=[];let binaries=0;const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 // Node's WASIX symlink/bin-link helper is not reliable. Materialize genuine
 // shell launchers, just as portable package managers do; execute real code.
 for(const item of findPackages(cwd)){
  const bin=typeof item.manifest.bin==='string'?{[item.manifest.name.split('/').pop()]:item.manifest.bin}:item.manifest.bin||{};const segments=item.root.split('/'),at=segments.lastIndexOf('node_modules');if(at<0)continue;const dir=segments.slice(0,at+1).join('/')+'/.bin';
  for(const[name,relative]of Object.entries(bin)){if(!/^[A-Za-z0-9_.-]+$/.test(name)||typeof relative!=='string')continue;const target=path.resolve(item.root,relative);if(!target.startsWith(item.root+'/')||!fs.existsSync(target))continue;const prefix=fs.readFileSync(target).subarray(0,256).toString('utf8');let launcher;if(/(?:^#![^\n]*\bnode\b|\.(?:[cm]?js)$)/.test(prefix)||/\.(?:[cm]?js)$/.test(target))launcher='exec node '+quote(target)+' "$@"';else if(/^#![^\n]*\b(?:sh|bash)\b/.test(prefix))launcher='exec sh '+quote(target)+' "$@"';else if(prefix.charCodeAt(0)===0&&prefix.slice(1,4)==='asm')launcher='exec '+quote(target)+' "$@"';else launcher='echo '+quote('Unsupported native executable '+name+'; choose a package WASM/JS build.')+' >&2\nexit 1';fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,name);try{fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}fs.writeFileSync(file,'#!/bin/sh\n'+launcher+'\n',{mode:0o755});fs.chmodSync(file,0o755);binaries++;
  }
 }
 if(binaries)actions.push({implementation:'portable executable launchers',binaries});
for(const item of findPackages(cwd))if(item.manifest.name==='sharp'){
 try{const wasmFile=require.resolve('@img/sharp-wasm32/package',{paths:[item.root]}),wasm=JSON.parse(fs.readFileSync(wasmFile,'utf8'));if(wasm.version!==item.manifest.version)continue;const modern=fs.existsSync(path.join(item.root,'dist/sharp.cjs')),dir=path.join(item.root,modern?'src/build/Release':'build/Release');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'sharp-wasm32-'+item.manifest.version+'.node.js'),"module.exports=require('@img/sharp-wasm32/sharp.node');\n");if(!modern)fs.writeFileSync(path.join(dir,'sharp-wasm32.node.js'),"module.exports=require('@img/sharp-wasm32/sharp.node');\n");actions.push({package:'sharp',version:item.manifest.version,implementation:'official @img/sharp-wasm32'})}catch(e){actions.push({package:'sharp',warning:e.message})}
 }return actions}
function doctor(cwd){const manifest=rootManifest(cwd).data,packages=findPackages(cwd);return{node:process.version,platform:process.platform,arch:process.arch,manager:'actual npm/pnpm in browser WASIX',root:cwd,directDependencies:{...manifest.dependencies,...manifest.devDependencies},portablePolicy:catalogue,installedPackages:packages.length,browserEntries:packages.filter(p=>p.manifest.browser||p.manifest.exports&&JSON.stringify(p.manifest.exports).includes('browser')).map(p=>({package:p.manifest.name,browser:p.manifest.browser,exports:p.manifest.exports})).slice(0,80),nativeBuilds:manifest.beownir?.nativeAddons||{},note:'Browser conditions apply only in browser-target mode. Native V8/NAN addons are not automatically convertible; use declared C/WASI exports or package WASM/JS alternatives.'}}
module.exports={catalogue,prepare,fixup,doctor,findPackages,metadata,splitSpec};
