// Beownir TCP relay v2. Independently implemented, credit-controlled transport.
// Wire: uint8 opcode, uint32 LE stream, payload. No project execution on host.
const OPEN=1,DATA=2,CLOSE=3,CREDIT=4,READY=5;
const WINDOW=256*1024,MAX_CHUNK=64*1024,MAX_SOCKET_BUFFER=1024*1024;
const liveConnections=new Set();
export const debugTCPStats=()=>[...liveConnections].map(c=>[...c.streams.values()].map(s=>({id:s.id,tx:s.tx??0,rx:s.rx??0,drained:s.drained??0,writeCredit:s.allowance,readCredit:s.receivable,buffered:s.buffered,closed:s.closed,blocked:s.blocked})));
function packet(op,id,payload=new Uint8Array()){
  const p=new Uint8Array(5+payload.byteLength);p[0]=op;new DataView(p.buffer).setUint32(1,id,true);p.set(payload,5);return p;
}
function credit(n){const p=new Uint8Array(4);new DataView(p.buffer).setUint32(0,n,true);return p;}
class RelayStream {
  constructor(connection,id){this.connection=connection;this.id=id;this.allowance=WINDOW;this.receivable=WINDOW;this.buffered=0;this.closed=false;this.blocked=false;}
  get writableBytes(){return !this.closed&&this.connection.ws.readyState===1&&this.connection.ws.bufferedAmount<MAX_SOCKET_BUFFER?Math.min(MAX_CHUNK,this.allowance):0;}
  send(bytes){
    if(this.closed||bytes.byteLength>MAX_CHUNK)return 0;
    const writable=this.writableBytes;
    if(!writable){this.blocked=true;this.connection.watchWritable(this);return 0;}
    // The WASIX network ABI accepts short writes. Returning a real partial write
    // avoids a false permanent stall when the remote credit window is narrower
    // than the caller's buffer.
    const count=Math.min(bytes.byteLength,writable),part=count===bytes.byteLength?bytes:bytes.subarray(0,count);
    this.tx=(this.tx??0)+count;this.allowance-=count;this.connection.send(DATA,this.id,part);
    if(count<bytes.byteLength||this.writableBytes===0){this.blocked=true;this.connection.watchWritable(this);}
    return count;
  }
  consumed(count){if(count<0||count>this.buffered)throw new Error('Invalid TCP credit');this.drained=(this.drained??0)+count;this.buffered-=count;this.receivable+=count;if(!this.closed)this.connection.send(CREDIT,this.id,credit(count));}
  close(){if(this.closed)return;this.closed=true;this.connection.unwatchWritable(this);this.connection.send(CLOSE,this.id);this.connection.streams.delete(this.id);this.onclose?.();}
  receive(bytes){if(bytes.byteLength>MAX_CHUNK||bytes.byteLength>this.receivable)throw new Error('TCP relay exceeded receive window');this.rx=(this.rx??0)+bytes.byteLength;this.receivable-=bytes.byteLength;this.buffered+=bytes.byteLength;this.onmessage?.(bytes);}
  remoteClose(){if(this.closed)return;this.closed=true;this.connection.unwatchWritable(this);this.connection.streams.delete(this.id);this.onclose?.();}
  notifyWritable(){if(this.closed||this.writableBytes<=0)return false;this.blocked=false;this.onwritable?.();return true;}
}
class BrowserTCPConnection {
  constructor(url){
    liveConnections.add(this);this.streams=new Map();this.sequence=0;this.ready=false;this.closed=false;this.waitingWritable=new Set();this.drainTimer=undefined;this.ws=new WebSocket(url);this.ws.binaryType='arraybuffer';
    this.ws.onmessage=({data})=>{try{this.receive(new Uint8Array(data))}catch(e){console.error('TCP relay protocol:',e.message);this.close()}};
    this.ws.onerror=()=>this.onerror?.();this.ws.onclose=()=>{if(this.closed)return;this.closed=true;liveConnections.delete(this);this.clearWritableWait();for(const s of [...this.streams.values()])s.remoteClose();this.onclose?.()};
  }
  send(op,id,bytes){if(this.ws.readyState!==1)throw new Error('TCP relay is closed');this.ws.send(packet(op,id,bytes));}
  watchWritable(stream){
    if(stream.closed)return;this.waitingWritable.add(stream);if(this.drainTimer===undefined)this.pollWritable();
  }
  unwatchWritable(stream){this.waitingWritable.delete(stream);if(!this.waitingWritable.size&&this.drainTimer!==undefined){clearTimeout(this.drainTimer);this.drainTimer=undefined;}}
  clearWritableWait(){if(this.drainTimer!==undefined)clearTimeout(this.drainTimer);this.drainTimer=undefined;this.waitingWritable.clear();}
  pollWritable(){
    if(this.closed||!this.waitingWritable.size){this.clearWritableWait();return;}
    for(const stream of [...this.waitingWritable]){
      if(stream.closed){this.waitingWritable.delete(stream);continue;}
      if(stream.notifyWritable())this.waitingWritable.delete(stream);
    }
    if(this.waitingWritable.size)this.drainTimer=setTimeout(()=>{this.drainTimer=undefined;this.pollWritable()},16);
    else this.clearWritableWait();
  }
  receive(p){if(p.byteLength<5)throw new Error('Truncated TCP packet');const op=p[0],id=new DataView(p.buffer,p.byteOffset,p.byteLength).getUint32(1,true),body=p.subarray(5);
    if(op===READY&&id===0&&!this.ready){if(body[0]!==1)throw new Error('Unsupported TCP protocol');this.ready=true;this.onopen?.();return;}
    const s=this.streams.get(id);if(!s)return;
    if(op===DATA)s.receive(body);
    else if(op===CREDIT){if(body.byteLength!==4)throw new Error('Invalid credit');const n=new DataView(body.buffer,body.byteOffset,4).getUint32(0,true);if(n>WINDOW||s.allowance+n>WINDOW)throw new Error('Credit overflow');s.allowance+=n;s.notifyWritable()||this.watchWritable(s);}
    else if(op===CLOSE)s.remoteClose();else throw new Error('Unknown TCP opcode');
  }
  create_stream(host,port,type){if(!this.ready||this.closed||type!=='tcp')throw new Error('TCP transport is not ready');if(this.streams.size>=32)throw new Error('TCP stream limit');const id=++this.sequence;const s=new RelayStream(this,id);this.streams.set(id,s);this.send(OPEN,id,new TextEncoder().encode(JSON.stringify({host,port})));return s;}
  close(){if(this.closed)return;this.closed=true;liveConnections.delete(this);this.clearWritableWait();for(const s of [...this.streams.values()])s.remoteClose();this.ws.close();this.onclose?.();}
}
// Adapter for the SDK's documented three-method stream-client interface.
export const client={ClientConnection:BrowserTCPConnection};
