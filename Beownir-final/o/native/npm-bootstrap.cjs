'use strict';
// The upstream WASIX package aliases its `npm` command to pnpm. Bootstrap the
// official npm CLI explicitly, then execute npm-cli.js with the real guest Node.
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const ROOT='/workspace/.beownir/npm-cli',VERSION='11.21.1',ENTRY=ROOT+'/node_modules/npm/bin/npm-cli.js';
async function ensure(){if(fs.existsSync(ENTRY)){const pkg=JSON.parse(fs.readFileSync(ROOT+'/node_modules/npm/package.json','utf8'));if(pkg.name==='npm'&&pkg.version===VERSION)return ENTRY}
 fs.mkdirSync(ROOT,{recursive:true});fs.writeFileSync(ROOT+'/package.json',JSON.stringify({name:'beownir-npm-tool',version:'1.0.0',private:true,dependencies:{npm:VERSION}}));
 const args=['--dir',ROOT,'--ignore-workspace','install','--ignore-scripts','--config.update-notifier=false'];
 const code=await new Promise((resolve,reject)=>{const child=cp.spawn('pnpm',args,{cwd:ROOT,env:{...process.env,PNPM_DISABLE_SELF_UPDATE_CHECK:'1'},stdio:'inherit'});child.on('error',reject);child.on('close',code=>resolve(code??1))});
 if(code!==0||!fs.existsSync(ENTRY))throw Error('Official npm '+VERSION+' bootstrap failed');return ENTRY;
}
module.exports={ensure,ENTRY,VERSION};if(require.main===module)ensure().then(file=>console.log('NPM_CLI_READY '+file)).catch(error=>{console.error(error.stack);process.exitCode=1});
