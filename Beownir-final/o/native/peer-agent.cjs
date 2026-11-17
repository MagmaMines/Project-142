'use strict';
// Shared virtual loopback across isolated engine memories. Endpoints are real
// guest net.Sockets, preserving backpressure and TCP half-close semantics.
const net=require('node:net'),servers=new Map(),sockets=new Map();let nextSocket=0,input='';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
function attach(id,socket,upstream=false){const entry={id,socket,upstream,queue:[],waiting:false,ended:false,endSent:false,closed:false};sockets.set(id,entry);socket.pause();
 function pump(){if(entry.closed||entry.waiting)return;if(entry.queue.length){entry.waiting=true;emit({type:'peer-data',socket:id,data:entry.queue.shift().toString('base64')});return}if(entry.ended){if(!entry.endSent){entry.endSent=true;emit({type:'peer-end',socket:id})}}else socket.resume()}
 entry.pump=pump;socket.on('data',bytes=>{socket.pause();for(let offset=0;offset<bytes.length;offset+=65536)entry.queue.push(bytes.subarray(offset,offset+65536));pump()});socket.on('end',()=>{entry.ended=true;pump()});socket.on('error',error=>emit({type:'peer-error',socket:id,error:error.message}));socket.on('close',()=>{entry.closed=true;sockets.delete(id);emit({type:'peer-close',socket:id})});return entry;
}
async function configure(port,active){if(!Number.isInteger(port)||port<1||port>65535||port>=60000&&port<=62001)throw Error('Reserved or invalid peer port');if(!active){const server=servers.get(port);if(!server)return;servers.delete(port);await new Promise(resolve=>server.close(resolve));return}if(servers.has(port))return;const server=net.createServer({allowHalfOpen:true},socket=>{if(sockets.size>=64){socket.destroy();return}const id='local:'+ ++nextSocket;attach(id,socket);emit({type:'peer-open',socket:id,port})});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve)});servers.set(port,server)}
async function command(message){const id=message.socket,entry=sockets.get(id);switch(message.action){
 case'connect':{if(sockets.has(id)||sockets.size>=64)throw Error('Peer stream budget');const socket=new net.Socket({allowHalfOpen:true});const created=attach(id,socket,true);await new Promise((resolve,reject)=>{socket.once('error',reject);socket.connect({host:'127.0.0.1',port:message.port},resolve)});return}
 case'ready':if(entry)entry.pump();return;
 case'data':if(!entry)throw Error('Peer stream closed');if(typeof message.data!=='string'||message.data.length>90000)throw Error('Peer data budget');await new Promise((resolve,reject)=>entry.socket.write(Buffer.from(message.data,'base64'),error=>error?reject(error):resolve()));return;
 case'credit':if(entry){entry.waiting=false;entry.pump()}return;
 case'end':if(entry)await new Promise(resolve=>entry.socket.end(resolve));return;
 case'destroy':if(entry)entry.socket.destroy();return;
 default:throw Error('Unsupported peer control');
}}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1024*1024){input='';throw Error('Peer control framing budget')}for(;;){const end=input.indexOf('\n');if(end<0)break;const line=input.slice(0,end);input=input.slice(end+1);if(!line)continue;let message;try{message=JSON.parse(line)}catch{continue}Promise.resolve().then(()=>command(message)).then(value=>emit({type:'peer-reply',rid:message.rid,value}),error=>emit({type:'peer-reply',rid:message.rid,error:error.message}))}});
module.exports={configure};
