'use strict';
// Browser guest daemon: actual mtime updates and pathname-stream address allocation.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const peers=require('./peer-agent.cjs');
const token=process.env.BEOWNIR_FS_TOKEN,ipcToken=process.env.BEOWNIR_IPC_TOKEN,ipc=new Map();let candidate=60000;
function freePort(){return new Promise((resolve,reject)=>{const attempt=()=>{if(candidate>61999)return reject(Error('IPC address space exhausted'));const port=candidate++,probe=net.createServer();probe.once('error',e=>e.code==='EADDRINUSE'?attempt():reject(e));probe.listen(port,'127.0.0.1',()=>probe.close(()=>resolve(port)))};attempt()})}
http.createServer((req,res)=>{
 const touch=req.url==='/touch'&&req.headers['x-beownir-fs-token']===token;
 const peer=req.url==='/peers'&&req.headers['x-beownir-fs-token']===token;
 const allocate=req.url==='/ipc'&&typeof ipcToken==='string'&&req.headers['x-beownir-ipc-token']===ipcToken;
 if(req.method!=='POST'||(!touch&&!allocate&&!peer)){res.writeHead(403).end();return}
 let data='',size=0;req.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy();else data+=chunk.toString('utf8')});req.on('end',()=>{
  try{
   const input=JSON.parse(data);if(peer){peers.configure(input.port,input.active===true).then(()=>res.writeHead(200,{'content-type':'application/json'}).end('{\"ok\":true}'),error=>res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:error.message})));return}
   if(allocate){if(typeof input.path!=='string'||input.path.length>4096||ipc.size>=1024)throw Error('Invalid or exhausted IPC address');let pending=ipc.get(input.path);if(!pending){pending=freePort();ipc.set(input.path,pending)}pending.then(port=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({port})),e=>res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:e.message})));return}
   if(!Array.isArray(input)||input.length>20000)throw Error('Invalid metadata batch');
   for(const relative of input){if(typeof relative!=='string'||relative.includes('\0')||relative.includes('\\'))throw Error('Invalid workspace path');const file=path.resolve('/workspace',relative);if(file!=='/workspace'&&!file.startsWith('/workspace/'))throw Error('Path escapes workspace');try{const before=fs.statSync(file),now=new Date(Math.max(Date.now(),Number(before.mtimeMs)+1));fs.utimesSync(file,now,now)}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))throw e}}
   res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}');
  }catch(e){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:e.message}))}
 })
}).listen(62001,'127.0.0.1');
