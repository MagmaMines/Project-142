'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const action=process.argv[2]||'help',args=process.argv.slice(3);
(async()=>{
 if(action==='doctor'){console.log(JSON.stringify(require('./compatibility-policy.cjs').doctor(process.cwd()),null,2));return}
 if(action==='native-build'){await require('./native-addons.cjs').build(process.cwd());return}
 if(action==='checkpoint'){console.log('Workspace checkpoint requested. The browser supervisor saves modules/build artifacts after this command.');return}
 if(action==='browser'){
  if(!args[0])throw Error('Usage: beownir browser file.js');const file=path.resolve(process.cwd(),args[0]);if(!file.startsWith('/workspace/'))throw Error('Browser-target entry must be in the workspace');const env={...process.env,BEOWNIR_MODULE_TARGET:'browser',NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --conditions=browser'};
  const code=await new Promise((resolve,reject)=>{const child=cp.spawn(process.execPath,[file,...args.slice(1)],{env,cwd:process.cwd(),stdio:'inherit'});child.on('error',reject);child.on('close',code=>resolve(code??1))});process.exitCode=code;return;
 }
 if(action==='help'){console.log('beownir doctor          inspect modules, browser entries and native-addon plans\nbeownir native-build    source → WASI attempt → declared JS fallback\nbeownir checkpoint      save dependency/build snapshot\nbeownir browser app.js  Node process with browser export conditions + browser-field mapping\nDOM frontend apps still run in the actual browser preview through Vite/Next/Nuxt.');return}
 throw Error('Unknown beownir command '+action);
})().catch(error=>{console.error(error.stack);process.exitCode=1});
