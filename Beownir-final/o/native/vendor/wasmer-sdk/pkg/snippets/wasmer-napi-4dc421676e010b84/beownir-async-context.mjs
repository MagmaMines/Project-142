// Beownir continuation context. One JavaScript agent per guest process.
// Await resolution is serialized through microtask fences; unrelated
// continuations cannot observe another request's AsyncLocalStorage frame.
const P=Promise,then=P.prototype.then,enqueue=queueMicrotask.bind(globalThis);
let current=new Map(),busy=false;const ready=[];
const invoke=(frame,fn,receiver,args)=>{const prior=current;current=frame;try{return Reflect.apply(fn,receiver,args)}finally{current=prior}};
function drain(){if(busy||!ready.length)return;busy=true;enqueue(()=>{const {frame,callback,value}=ready.shift(),prior=current;current=frame;try{callback(value)}finally{enqueue(()=>{current=prior;busy=false;drain()})}})}
export const asyncContext={revision:3,
 capture:()=>current,
 set:frame=>{current=frame},
 run:(frame,fn,receiver,args=[])=>invoke(frame,fn,receiver,args),
 wrap(fn){if(typeof fn!=='function')return fn;const frame=current;return function(...args){return invoke(frame,fn,this,args)}},
 withValue(key,value,fn,receiver,args=[]){const frame=new Map(current);frame.set(key,value);return invoke(frame,fn,receiver,args)},
 without(key,fn,receiver,args=[]){const frame=new Map(current);frame.delete(key);return invoke(frame,fn,receiver,args)},
 get:key=>current.get(key),
 enter(key,value){current=new Map(current);current.set(key,value)},
 await(value){const frame=current;return{then(resolve,reject){Reflect.apply(then,P.resolve(value),[value=>{ready.push({frame,callback:resolve,value});drain()},error=>{ready.push({frame,callback:reject,value:error});drain()}])}}},
 iterable(value){const asyncIterator=value?.[Symbol.asyncIterator],iterator=asyncIterator?asyncIterator.call(value):value[Symbol.iterator]();const convert=result=>asyncIterator?result:Reflect.apply(then,P.resolve(result.value),[value=>({value,done:result.done})]);const next=(method,args)=>{let result;try{result=typeof iterator[method]==='function'?iterator[method](...args):{done:true,value:args[0]}}catch(error){result=P.reject(error)}return asyncContext.await(Reflect.apply(then,P.resolve(result),[convert]))};return{[Symbol.asyncIterator](){return this},next(...a){return next('next',a)},return(...a){return next('return',a)},throw(...a){return next('throw',a)}}},
};
// Offsets are only inserted, never replaced: nested await expressions and
// for-await operands remain syntactically correct without an AST generator.
export function rewriteAwaits(source,parse,{body=false,module=false}={}){
 if(!/\b(?:await|eval)\b/.test(source))return source;
 const prefix=body?'(function(){\n':'',suffix=body?'\n})':'';
 const tree=parse(prefix+source+suffix,{ecmaVersion:'latest',sourceType:module?'module':'script',allowAwaitOutsideFunction:!body});
 const inserts=[],pending=[tree];while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;
  if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='eval'&&node.arguments?.[0]&&node.arguments[0].type!=='SpreadElement'){const a=node.arguments[0],start=a.start-prefix.length,end=a.end-prefix.length;if(start>=0&&end<=source.length){inserts.push({at:start,text:'__beownirEvalSource(eval,'});inserts.push({at:end,text:')'})}}
  const argument=node.type==='AwaitExpression'?node.argument:node.type==='ForOfStatement'&&node.await?node.right:null;
  if(argument){const start=argument.start-prefix.length,end=argument.end-prefix.length;if(start>=0&&end<=source.length){inserts.push({at:start,text:node.type==='AwaitExpression'?' __beownirAwait(':' __beownirAsyncIterable('});inserts.push({at:end,text:')'})}}
  for(const key of Object.keys(node)){if(key==='start'||key==='end')continue;const value=node[key];if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value)}
 }
 inserts.sort((a,b)=>b.at-a.at||(a.text===')'?-1:1));const chunks=[];let cursor=source.length;for(const edit of inserts){chunks.push(source.slice(edit.at,cursor),edit.text);cursor=edit.at}chunks.push(source.slice(0,cursor));return chunks.reverse().join('');
}

const nativeEval=eval,evalCache=new Map();
export function prepareEval(fn,source,parse){if(fn!==nativeEval||typeof source!=='string')return source;let transformed=evalCache.get(source);if(transformed===undefined){transformed=rewriteAwaits(source,parse);if(source.length<2*1024*1024){if(evalCache.size>=64)evalCache.delete(evalCache.keys().next().value);evalCache.set(source,transformed)}}return transformed}
