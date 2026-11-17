'use strict';
// Opt-in diagnostics preserve program behavior; no rejected promise is swallowed.
if(process.env.BEOWNIR_DIAGNOSE==='1'){
 const write=value=>{try{process.stderr.write('[runtime diagnostic pid '+process.pid+'] '+String(value)+'\n')}catch{}};
 const text=error=>{try{return typeof error?.stack==='string'?error.stack:typeof error?.message==='string'?error.message:String(error)}catch{return '<unprintable error>'}};
 process.on('uncaughtExceptionMonitor',(error,origin)=>write(origin+'\n'+text(error)));
 const exit=process.exit;process.exit=function(code){const value=code===undefined?process.exitCode:Number(code);if(value&&value!==130&&value!==143)write('process.exit('+value+')\n'+new Error('nonzero exit call site').stack);return Reflect.apply(exit,this,arguments)};
 const fatal=process._fatalException;if(typeof fatal==='function')process._fatalException=function(error,...args){write('fatal exception\n'+text(error));return Reflect.apply(fatal,this,[error,...args])};
 const consoleError=console.error;console.error=function(...values){return Reflect.apply(consoleError,this,values.map(value=>value&&typeof value==='object'&&('stack'in value||'message'in value)?text(value):value))};
}
