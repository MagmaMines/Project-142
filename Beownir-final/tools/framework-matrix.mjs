#!/usr/bin/env node
// Installs real frameworks from the npm registry into the virtual filesystem and
// boots them inside the runtime. Every row is evidence: the version installed,
// the code that ran, and either a result or the error that stopped it.
//
//   node tools/framework-matrix.mjs            # print the table
//   node tools/framework-matrix.mjs --write    # refresh o/compat/framework-matrix.json
//   node tools/framework-matrix.mjs --check    # fail if a previously passing row regressed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, initToolchain } from '../test/helpers/runtime.mjs';
import { resolveTree, installTree } from './framework-core.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baselinePath = path.join(root, 'o/compat/framework-matrix.json');

/* Each profile installs its own dependency tree and then runs a smoke script
 * inside the worker runtime. The script must return a string; a rejection or a
 * thrown error is recorded verbatim. */
const profiles = [
  {
    name: 'express',
    packages: [{ name: 'express', range: 'latest' }],
    smoke: `(async () => {
      const express = require('express');
      const app = express();
      app.get('/hello', (req, res) => res.json({ ok: true, query: req.query, path: req.path }));
      const server = app.listen(0);
      await once(server, 'listening');
      const response = await probe(server.port, '/hello?name=beownir');
      await new Promise(resolve => server.close(resolve));
      const body = JSON.parse(response.body);
      return 'express ' + require('express/package.json').version + ' served ' + response.status + ' ' + body.path + '?name=' + body.query.name;
    })()`,
  },
  {
    name: 'koa',
    packages: [{ name: 'koa', range: 'latest' }],
    smoke: `(async () => {
      const Koa = require('koa');
      const app = new Koa();
      app.use(ctx => { ctx.body = { ok: true, path: ctx.path }; });
      const server = http.createServer(app.callback());
      server.listen(0);
      await once(server, 'listening');
      const response = await probe(server.port, '/koa');
      await new Promise(resolve => server.close(resolve));
      return 'koa ' + require('koa/package.json').version + ' served ' + response.status + ' ' + JSON.parse(response.body).path;
    })()`,
  },
  {
    name: 'fastify',
    packages: [{ name: 'fastify', range: 'latest' }],
    smoke: `(async () => {
      const fastify = require('fastify')({ logger: false });
      fastify.get('/hello', async () => ({ ok: true }));
      await fastify.listen({ port: 0, host: '127.0.0.1' });
      const port = fastify.server.address().port;
      const response = await probe(port, '/hello');
      await fastify.close();
      return 'fastify ' + require('fastify/package.json').version + ' served ' + response.status + ' ' + JSON.parse(response.body).ok;
    })()`,
  },
  {
    name: 'hono',
    packages: [{ name: 'hono', range: 'latest' }],
    smoke: `(async () => {
      const { Hono } = require('hono');
      const app = new Hono();
      app.get('/hello', c => c.json({ ok: true, path: c.req.path }));
      const response = await app.fetch(new Request('http://localhost/hello'));
      const body = await response.json();
      return 'hono ' + require('hono/package.json').version + ' answered ' + response.status + ' ' + body.path;
    })()`,
  },
  {
    name: 'react',
    packages: [{ name: 'react', range: 'latest' }, { name: 'react-dom', range: 'latest' }],
    smoke: `(async () => {
      const React = require('react');
      const { renderToString } = require('react-dom/server');
      const html = renderToString(React.createElement('main', null, React.createElement('h1', null, 'beownir')));
      if (!html.includes('<main>') || !html.includes('beownir')) throw new Error('unexpected markup ' + html);
      return 'react ' + React.version + ' rendered ' + html;
    })()`,
  },
  {
    name: 'vue',
    packages: [{ name: 'vue', range: 'latest' }, { name: '@vue/server-renderer', range: 'latest' }],
    smoke: `(async () => {
      const { createSSRApp, h } = require('vue');
      const { renderToString } = require('@vue/server-renderer');
      const html = await renderToString(createSSRApp({ render: () => h('p', null, 'beownir') }));
      if (!html.includes('beownir')) throw new Error('unexpected markup ' + html);
      return 'vue ' + require('vue/package.json').version + ' rendered ' + html;
    })()`,
  },
  {
    name: 'preact',
    // preact 11 is ESM only (main/exports both point at .mjs): this row is the
    // end-to-end proof that require() of an ES module works.
    packages: [{ name: 'preact', range: 'latest' }, { name: 'preact-render-to-string', range: 'latest' }],
    smoke: `(async () => {
      const { h } = require('preact');
      const render = require('preact-render-to-string');
      const html = render(h('section', null, 'beownir'));
      if (!html.includes('beownir')) throw new Error('unexpected markup ' + html);
      return 'preact ' + require('preact/package.json').version + ' rendered ' + html;
    })()`,
  },
  {
    name: 'svelte',
    packages: [{ name: 'svelte', range: 'latest' }],
    note: 'ESM-only compiler reached through the "svelte/compiler" subpath export',
    smoke: `(async () => {
      const { compile } = require('svelte/compiler');
      const compiled = compile('<h1 class="hero">hello {name}</h1>', { generate: 'client' });
      if (!compiled.js || !compiled.js.code.includes('hello')) throw new Error('compiler produced no markup');
      return 'svelte ' + require('svelte/package.json').version + ' compiled ' + compiled.js.code.length + ' bytes';
    })()`,
  },
  {
    name: 'vite',
    packages: [{ name: 'vite', range: '^6' }],
    note: 'Node API loads through the CJS shim + dynamic import; a dev server still needs rollup/esbuild as WASM',
    smoke: `(async () => {
      const vite = require('vite');
      if (typeof vite.createServer !== 'function' || typeof vite.build !== 'function') throw new Error('vite API is incomplete');
      return 'vite ' + require('vite/package.json').version + ' loaded ' + Object.keys(vite).length + ' exports';
    })()`,
  },
  {
    name: 'hapi',
    packages: [{ name: '@hapi/hapi', range: 'latest' }],
    smoke: `(async () => {
      const Hapi = require('@hapi/hapi');
      const server = Hapi.server({ port: 0, host: '127.0.0.1' });
      server.route({ method: 'GET', path: '/h', handler: () => ({ ok: true }) });
      await server.start();
      const response = await probe(server.info.port, '/h');
      await server.stop();
      return 'hapi ' + require('@hapi/hapi/package.json').version + ' served ' + response.status + ' ' + response.body;
    })()`,
  },
  {
    name: 'zod',
    packages: [{ name: 'zod', range: 'latest' }],
    smoke: `(async () => {
      const { z } = require('zod');
      const parsed = z.object({ name: z.string(), port: z.number().int() }).parse({ name: 'beownir', port: 4000 });
      const rejected = z.object({ name: z.string() }).safeParse({ name: 7 }).success;
      if (rejected) throw new Error('zod accepted an invalid payload');
      return 'zod ' + require('zod/package.json').version + ' parsed ' + JSON.stringify(parsed);
    })()`,
  },
  {
    name: 'graphql',
    packages: [{ name: 'graphql', range: 'latest' }],
    smoke: `(async () => {
      const graphql = require('graphql');
      const schema = graphql.buildSchema('type Query { hello: String }');
      const result = await graphql.graphql({ schema, source: '{ hello }', rootValue: { hello: 'beownir' } });
      return 'graphql ' + graphql.version + ' executed {' + result.data.hello + '}';
    })()`,
  },
  {
    name: 'socket.io',
    packages: [{ name: 'socket.io', range: 'latest' }],
    smoke: `(async () => {
      const { Server } = require('socket.io');
      const server = http.createServer((req, res) => res.end('http'));
      const io = new Server(server);
      server.listen(0);
      await once(server, 'listening');
      const port = server.address().port;
      const response = await probe(port, '/socket.io/?EIO=4&transport=polling');
      io.close();
      await new Promise(resolve => server.close(resolve));
      const handshake = JSON.parse(response.body.slice(response.body.indexOf('{')));
      return 'socket.io ' + require('socket.io/package.json').version + ' handshake sid=' + (handshake.sid ? 'yes' : 'no') + ' status=' + response.status;
    })()`,
  },
  {
    name: 'typescript',
    packages: [{ name: 'typescript', range: '^5' }],
    note: 'typescript 7 is the native compiler and only exports its version; ^5 is the JS API',
    smoke: `(async () => {
      const ts = require('typescript');
      const output = ts.transpileModule('const greet = (name: string): string => "hi " + name;', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      });
      if (typeof ts.sys !== 'object') throw new Error('typescript did not detect a Node-like system (process.browser?)');
      return 'typescript ' + ts.version + ' compiled ' + JSON.stringify(output.outputText.trim());
    })()`,
  },
  {
    name: 'babel',
    packages: [{ name: '@babel/core', range: 'latest' }, { name: '@babel/preset-react', range: 'latest' }],
    smoke: `(async () => {
      const babel = require('@babel/core');
      const result = babel.transformSync('const App = () => <main>hello</main>;', {
        presets: [['@babel/preset-react', { runtime: 'classic' }]], babelrc: false, configFile: false,
      });
      const code = result.code.replace(/\\s+/g, ' ').trim();
      if (!code.includes('createElement')) throw new Error('babel did not transform JSX: ' + code);
      return 'babel ' + require('@babel/core/package.json').version + ' transformed JSX';
    })()`,
  },
  {
    name: 'postcss',
    packages: [{ name: 'postcss', range: 'latest' }],
    smoke: `(async () => {
      const postcss = require('postcss');
      const plugin = { postcssPlugin: 'smoke', Declaration: declaration => { if (declaration.prop === 'color') declaration.value = 'blue'; } };
      const result = await postcss([plugin]).process('.a { color: red }', { from: '/project/style.css' });
      return 'postcss ' + require('postcss/package.json').version + ' produced ' + JSON.stringify(result.css);
    })()`,
  },
  {
    name: 'sass',
    packages: [{ name: 'sass', range: 'latest' }],
    smoke: `(async () => {
      const sass = require('sass');
      const result = sass.compileString('$colour: red; .a { color: $colour; }');
      return 'sass ' + require('sass/package.json').version + ' compiled ' + JSON.stringify(result.css.trim());
    })()`,
  },
  {
    name: 'yargs',
    packages: [{ name: 'yargs', range: 'latest' }],
    smoke: `(async () => {
      const load = require('yargs/yargs');
      const yargs = load.default || load;
      const argv = yargs(['--port', '3000', '--name', 'beownir', 'file.txt'])
        .option('port', { type: 'number' })
        .option('name', { type: 'string' })
        .parse();
      if (argv.port !== 3000) throw new Error('yargs did not coerce --port: ' + argv.port);
      return 'yargs ' + require('yargs/package.json').version + ' parsed port=' + argv.port + ' name=' + argv.name;
    })()`,
  },
  {
    name: 'chalk',
    packages: [{ name: 'chalk', range: 'latest' }],
    note: 'chalk resolves "#ansi-styles" through its package.json "imports" map',
    smoke: `(async () => {
      const load = require('chalk');
      const chalk = load.default && typeof load.default.red === 'function' ? load.default : load;
      const text = chalk.red('beownir');
      if (typeof text !== 'string' || !chalk.hex('#00ff00')) throw new Error('chalk surface is incomplete');
      return 'chalk ' + require('chalk/package.json').version + ' styled ' + JSON.stringify(text) + ' at level ' + chalk.level;
    })()`,
  },
  {
    name: 'dotenv',
    packages: [{ name: 'dotenv', range: 'latest' }],
    smoke: `(async () => {
      const dotenv = require('dotenv');
      const fs = require('fs');
      fs.mkdirSync('/project/smoke', { recursive: true });
      fs.writeFileSync('/project/smoke/.env', 'GREETING=hello\\nPORT=8080\\n');
      const result = dotenv.config({ path: '/project/smoke/.env' });
      if (process.env.GREETING !== 'hello') throw new Error('dotenv did not populate process.env');
      return 'dotenv ' + require('dotenv/package.json').version + ' loaded ' + JSON.stringify(result.parsed);
    })()`,
  },
  {
    name: 'esbuild',
    packages: [{ name: 'esbuild', range: 'latest' }],
    note: 'require("esbuild") is served by the embedded esbuild WASM build through the shim; the native package binary is never loaded',
    smoke: `(async () => {
      const esbuild = require('esbuild');
      const out = await esbuild.transform('const n: number = 1', { loader: 'ts' });
      return 'esbuild ' + esbuild.version + ' transformed -> ' + out.code.trim();
    })()`,
  },
  {
    name: 'vite-dev-transform',
    packages: [{ name: 'vite', range: '6' }],
    note: 'Vite 6 dev server: createServer and transformRequest run TypeScript through the WASM esbuild and the WASM Rollup',
    smoke: `(async () => {
      const fs = require('fs');
      fs.mkdirSync('/project/smoke/vite', { recursive: true });
      fs.writeFileSync('/project/smoke/vite/main.ts', 'import { a } from "./lib"; const n: number = a; console.log(n);');
      fs.writeFileSync('/project/smoke/vite/lib.ts', 'export const a: number = 1;');
      const vite = require('vite');
      const server = await vite.createServer({ root: '/project/smoke/vite', configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
      try {
        const out = await server.transformRequest('/main.ts');
        if (!out.code.includes('const n = a')) throw new Error('TypeScript was not stripped: ' + out.code.slice(0, 120));
        return 'vite ' + vite.version + ' transformed main.ts, imports rewritten to ' + (out.code.includes('"/lib.ts"') ? '/lib.ts' : 'unknown');
      } finally { await server.close(); }
    })()`,
  },
  {
    name: 'vite-http-dev-server',
    packages: [{ name: 'vite', range: '6' }],
    note: 'Vite dev server binds to the project virtual loopback; an HTTP client fetches the served HTML and transformed module over the runtime kernel',
    smoke: `(async () => {
      const fs = require('fs');
      const http = require('http');
      const root = '/project/smoke/vite-http';
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(root + '/index.html', '<html><body><script type="module" src="/src.js"></script></body></html>');
      fs.writeFileSync(root + '/src.js', 'export const message = "hello vite";');
      const vite = require('vite');
      const server = await vite.createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, appType: 'spa', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
      const get = path => new Promise((resolve, reject) => http.get({host:'127.0.0.1', port:server.httpServer.address().port, path}, res => { const chunks=[]; res.on('data', c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode, body:Buffer.concat(chunks).toString()})); }).on('error', reject));
      try {
        await server.listen();
        const page = await get('/');
        const module = await get('/src.js');
        if (page.status !== 200 || !page.body.includes('/@vite/client')) throw new Error('dev HTML not served: ' + page.status);
        if (module.status !== 200 || !module.body.includes('hello vite')) throw new Error('module not served: ' + module.status + ' ' + module.body.slice(0,120));
        return 'vite HTTP ' + page.status + ' index, ' + module.status + ' transformed module on virtual port ' + server.httpServer.address().port;
      } finally { await server.close(); }
    })()`,
  },
  {
    name: 'vite-production-build',
    packages: [{ name: 'vite', range: '6' }],
    note: 'Vite 6 production build with the WASM Rollup/esbuild providers; verifies emitted HTML, JS bundle and CSS asset from a real virtual project',
    smoke: `(async () => {
      const fs = require('fs');
      const root = '/project/smoke/vite-build';
      fs.mkdirSync(root, {recursive:true});
      fs.mkdirSync(root + '/src', {recursive:true});
      fs.writeFileSync(root + '/index.html', '<html><head></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>');
      fs.writeFileSync(root + '/src/main.js', 'import "./style.css"; document.querySelector("#app").textContent = "vite production";');
      fs.writeFileSync(root + '/src/style.css', '#app { color: rgb(1, 2, 3); }');
      const vite = require('vite');
      const result = await vite.build({root, configFile:false, logLevel:'silent', build:{outDir:'build', emptyOutDir:true, minify:false}, optimizeDeps:{noDiscovery:true,include:[]}});
      const files = fs.readdirSync(root + '/build/assets');
      const html = fs.readFileSync(root + '/build/index.html','utf8');
      const js = files.find(f=>/^index-.*\\.js$/.test(f));
      const css = files.find(f=>/^index-.*\\.css$/.test(f));
      if (!html.includes('assets/') || !js || !css) throw new Error('expected HTML, JS and CSS outputs, got '+JSON.stringify(files));
      if (!fs.readFileSync(root + '/build/assets/'+js,'utf8').includes('vite production')) throw new Error('JS output lost the app payload');
      return 'vite ' + vite.version + ' production build emitted index.html, ' + js + ' and ' + css;
    })()`,
  },
  {
    name: 'vite-cli-production-build',
    packages: [{ name: 'vite', range: '6' }],
    files: {
      'index.html': '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': 'const greeting: string = "Vite CLI in single-file runtime"; document.body.textContent = greeting;',
    },
    command: 'vite --version && vite build --outDir build --emptyOutDir --no-minify',
    verify: `(() => { const fs = require('fs'); const html = fs.readFileSync('/project/build/index.html', 'utf8'); const assets = fs.readdirSync('/project/build/assets'); const js = assets.find(name => name.endsWith('.js')); if (!html.includes('/assets/') || !js || !fs.readFileSync('/project/build/assets/' + js, 'utf8').includes('Vite CLI in single-file runtime')) throw new Error('Vite CLI did not emit the expected TypeScript app bundle'); return 'verified index.html and ' + js; })()`,
    note: 'Runs the Vite 6 command through its installed Node API and WASM bundler; validates TypeScript output and bundle content; unsupported CLI options are rejected rather than silently ignored',
  },
  {
    name: 'vite-react-production-build',
    packages: [{ name: 'vite', range: '6' }, { name: 'react', range: '19' }, { name: 'react-dom', range: '19' }],
    note: 'Integrated Vite 6 + React 19 production build from a virtual project; validates JSX transform, package resolution, Rollup output and emitted entry bundle (not browser hydration or arbitrary plugins)',
    smoke: `(async () => {
      const fs = require('fs');
      const root = '/project/smoke/vite-react';
      fs.mkdirSync(root + '/src', {recursive:true});
      fs.writeFileSync(root + '/index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
      fs.writeFileSync(root + '/src/main.jsx', 'import React from "react"; import { createRoot } from "react-dom/client"; function App(){ return <main>Beownir Vite React</main> }; createRoot(document.getElementById("root")).render(<App/>);');
      const vite = require('vite');
      await vite.build({root, configFile:false, logLevel:'silent', build:{outDir:'build', emptyOutDir:true, minify:false}, optimizeDeps:{noDiscovery:true,include:[]}});
      const html = fs.readFileSync(root + '/build/index.html','utf8');
      const assets = fs.readdirSync(root + '/build/assets');
      const js = assets.find(name=>name.endsWith('.js'));
      if (!html.includes('/assets/') || !js) throw new Error('Vite did not emit an HTML entry and JS asset: '+JSON.stringify(assets));
      const bundle = fs.readFileSync(root + '/build/assets/'+js,'utf8');
      if (!bundle.includes('Beownir Vite React') || !bundle.includes('createRoot')) throw new Error('React JSX/app entry missing from bundle');
      return 'vite '+vite.version+' + React '+require('react/package.json').version+' production bundle emitted '+js+' with JSX and createRoot';
    })()`,
  },
  {
    name: 'vite-react-dev-server',
    packages: [{ name: 'vite', range: '6' }, { name: 'react', range: '19' }, { name: 'react-dom', range: '19' }],
    note: 'Integrated Vite 6 + React 19 dev server: serves project HTML and transforms JSX with package imports through the virtual HTTP loopback (not browser hydration or HMR WebSocket)',
    smoke: `(async () => {
      const fs = require('fs');
      const root = '/project/smoke/vite-react-dev';
      fs.mkdirSync(root + '/src', {recursive:true});
      fs.writeFileSync(root + '/index.html', '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
      fs.writeFileSync(root + '/src/main.jsx', 'import React from "react"; import { createRoot } from "react-dom/client"; function App(){ return <main>React dev smoke</main> }; createRoot(document.getElementById("root")).render(<App/>);');
      const vite = require('vite');
      const server = await vite.createServer({root, configFile:false, server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:null}, appType:'spa', logLevel:'silent', optimizeDeps:{noDiscovery:true,include:[]}});
      try {
        await server.listen();
        const port = server.httpServer.address().port;
        const page = await probe(port, '/');
        const module = await probe(port, '/src/main.jsx');
        if (page.status !== 200 || !page.body.includes('/@vite/client')) throw new Error('React dev HTML failed: '+page.status);
        if (module.status !== 200 || !module.body.includes('React dev smoke') || !module.body.includes('react-dom')) throw new Error('React JSX transform failed: '+module.status+' '+module.body.slice(0,180));
        return 'vite '+vite.version+' + React '+require('react/package.json').version+' dev HTTP '+page.status+' HTML, '+module.status+' JSX module with React imports';
      } finally { await server.close(); }
    })()`,
  },
  {
    name: 'vite-hmr-websocket',
    packages: [{ name: 'vite', range: '6' }],
    note: 'End-to-end Vite HMR over the runtime virtual WebSocket: handshake, connected frame, file edit and update frame. Does not assert browser DOM rendering.',
    smoke: `(async () => {
      const fs = require('fs');
      const vite = require('vite');
      const root='/project/smoke/vite-hmr-ws';
      fs.mkdirSync(root,{recursive:true});
      fs.writeFileSync(root+'/index.html','<script type="module" src="/src.js"></script>');
      fs.writeFileSync(root+'/src.js','export const ready=true;');
      const server=await vite.createServer({root,configFile:false,server:{host:'127.0.0.1',port:0,strictPort:false},appType:'spa',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]}});
      let socket, buffer=Buffer.alloc(0), waiters=[];
      const deliver=chunk=>{
        buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
        while(buffer.length>=2){let len=buffer[1]&127,offset=2;if(len===126){if(buffer.length<4)return;len=buffer.readUInt16BE(2);offset=4;}else if(len===127){if(buffer.length<10)return;len=Number(buffer.readBigUInt64BE(2));offset=10;}if(buffer.length<offset+len)return;const opcode=buffer[0]&15,payload=buffer.subarray(offset,offset+len);buffer=buffer.subarray(offset+len);if(opcode===1){const next=waiters.shift();if(next)next(payload.toString('utf8'));}}
      };
      const nextMessage=label=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Vite HMR '+label+' message timed out')),4000);waiters.push(text=>{clearTimeout(timer);resolve(text);});});
      try {
        await server.listen();
        const port=server.httpServer.address().port;
        await probe(port,'/');
        await probe(port,'/src.js');
        const response=await new Promise((resolve,reject)=>{
          const req=http.request({host:'127.0.0.1',port,path:'/',headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13','Sec-WebSocket-Protocol':'vite-hmr'}});
          const timer=setTimeout(()=>{req.destroy();reject(new Error('Vite HMR upgrade timed out'));},3000);
          req.on('upgrade',(res,upgraded,head)=>{clearTimeout(timer);socket=upgraded;socket.on('data',deliver);socket.once('error',reject);if(head?.length)deliver(head);resolve(res.statusCode);});
          req.on('response',res=>{clearTimeout(timer);res.resume();reject(new Error('Vite HMR returned HTTP '+res.statusCode));});
          req.on('error',error=>{clearTimeout(timer);reject(error);});req.end();
        });
        if(response!==101)throw new Error('Expected 101 upgrade, got '+response);
        const connected=await nextMessage('connected');
        if(!connected.includes('connected'))throw new Error('Expected Vite connected frame, got '+connected.slice(0,120));
        fs.writeFileSync(root+'/src.js','export const ready=false;');
        let update='';
        for(let i=0;i<8;i++){update=await nextMessage('update');if(update.includes('update')||update.includes('full-reload'))break;}
        if(!update.includes('update')&&!update.includes('full-reload'))throw new Error('Expected HMR update/reload frame, got '+update.slice(0,160));
        return 'vite '+vite.version+' HMR WebSocket sent connected then update after src.js edit';
      } finally { if(socket&&!socket.destroyed)socket.destroy(); await server.close(); }
    })()`,
  },
  {
    name: 'vite-hmr-invalidation',
    packages: [{ name: 'vite', range: '6' }],
    note: 'HMR core: a file edit is seen by the watcher, the module graph invalidates, and the next transform returns the new code. The WebSocket transport is not part of this row',
    smoke: `(async () => {
      const fs = require('fs');
      fs.mkdirSync('/project/smoke/hmr', { recursive: true });
      fs.writeFileSync('/project/smoke/hmr/main.js', 'export const version = 1;');
      const vite = require('vite');
      const server = await vite.createServer({ root: '/project/smoke/hmr', configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
      const changes = [];
      try {
        server.watcher.on('change', file => changes.push(file));
        const before = (await server.transformRequest('/main.js')).code;
        await new Promise(resolve => setTimeout(resolve, 300));
        fs.writeFileSync('/project/smoke/hmr/main.js', 'export const version = 2;');
        let after = before;
        for (let i = 0; i < 40 && after === before; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          after = (await server.transformRequest('/main.js')).code;
        }
        if (!changes.some(file => file.endsWith('/main.js'))) throw new Error('the watcher reported no change');
        if (!after.includes('version = 2')) throw new Error('the transform still returns version 1');
        return 'vite-hmr re-transformed main.js after an edit: ' + before.trim() + ' -> ' + after.trim();
      } finally { await server.close(); }
    })()`,
  },
  {
    name: 'tailwind-4',
    packages: [{ name: 'tailwindcss', range: '4' }, { name: '@tailwindcss/postcss', range: '4' }, { name: 'postcss', range: 'latest' }],
    note: 'Tailwind v4 through its real PostCSS plugin. The native @tailwindcss/oxide scanner and lightningcss are served by JavaScript compat shims; output is correct but not minified',
    smoke: `(async () => {
      const fs = require('fs');
      fs.mkdirSync('/project/smoke/tw4', { recursive: true });
      fs.writeFileSync('/project/smoke/tw4/index.html', '<div class="flex bg-red-500 p-4 text-center">hi</div>');
      const postcss = require('postcss');
      const tailwind = require('@tailwindcss/postcss');
      const result = await postcss([tailwind()]).process('@import "tailwindcss";', { from: '/project/smoke/tw4/app.css' });
      const missing = ['.flex', '.bg-red-500', '.p-4', '.text-center'].filter(c => !result.css.includes(c));
      if (missing.length) throw new Error('utilities missing from the compiled CSS: ' + missing.join(' '));
      return 'tailwind ' + require('tailwindcss/package.json').version + ' compiled ' + result.css.length + ' bytes with flex, bg-red-500, p-4, text-center';
    })()`,
  },
  {
    name: 'mocha',
    packages: [{ name: 'mocha', range: 'latest' }],
    note: 'Test runner: a real spec file is written into the virtual project, loaded through the runtime, and run with pass/fail events',
    smoke: `(async () => {
      const fs = require('fs');
      fs.mkdirSync('/project/smoke', { recursive: true });
      fs.writeFileSync('/project/smoke/suite.spec.js', "const assert = require('assert'); describe('suite', () => { it('passes', () => assert.strictEqual(1 + 1, 2)); it('async passes', async () => { await new Promise(r => setTimeout(r, 5)); }); it('fails', () => assert.strictEqual(1, 2)); });");
      const { Mocha } = require('mocha');
      const mocha = new Mocha({ reporter: 'dot', ui: 'bdd' });
      mocha.addFile('/project/smoke/suite.spec.js');
      let passes = 0, fails = 0;
      const failures = await new Promise(resolve => { const runner = mocha.run(resolve); runner.on('pass', () => passes++); runner.on('fail', () => fails++); });
      return 'mocha ' + require('mocha/package.json').version + ' passes=' + passes + ' fails=' + fails + ' failures=' + failures;
    })()`,
  },
  {
    name: 'stylelint',
    packages: [{ name: 'stylelint', range: 'latest' }],
    note: 'Stylelint probes the cache with statSync({ throwIfNoEntry: false }) and must not throw on a cold run',
    smoke: `(async () => {
      const stylelint = require('stylelint');
      const result = await stylelint.lint({ code: 'a{color:red}', config: { rules: { 'color-named': 'never' } } });
      return 'stylelint ' + require('stylelint/package.json').version + ' warnings=' + result.results[0].warnings.length;
    })()`,
  },
  {
    name: 'chokidar',
    packages: [{ name: 'chokidar', range: 'latest' }],
    note: 'Live watcher: the initial scan emits ready, and an edit to a watched file emits change through readdirp',
    smoke: `(async () => {
      const fs = require('fs');
      fs.mkdirSync('/project/smoke/watch', { recursive: true });
      fs.writeFileSync('/project/smoke/watch/a.txt', 'one');
      const chokidar = require('chokidar');
      const seen = [];
      const watcher = chokidar.watch('/project/smoke/watch', { ignoreInitial: true });
      watcher.on('ready', () => seen.push('ready'));
      watcher.on('all', (event, file) => seen.push(event + ':' + file));
      await new Promise(resolve => setTimeout(resolve, 400));
      fs.writeFileSync('/project/smoke/watch/a.txt', 'two');
      await new Promise(resolve => setTimeout(resolve, 1200));
      await watcher.close();
      if (!seen.includes('change:/project/smoke/watch/a.txt')) throw new Error('no change event: ' + seen.join(','));
      return 'chokidar ' + require('chokidar/package.json').version + ' events=' + seen.join(' ');
    })()`,
  },
  {
    name: 'prettier',
    packages: [{ name: 'prettier', range: 'latest' }],
    note: 'ESM-only formatter reached through require() of a module without top-level await',
    smoke: `(async () => {
      const prettier = require('prettier');
      const out = await prettier.format('const a={b:1}', { parser: 'babel' });
      return 'prettier ' + prettier.version + ' formatted -> ' + out.trim();
    })()`,
  },
  {
    name: 'eslint',
    packages: [{ name: 'eslint', range: 'latest' }],
    note: 'Flat-config linter run through its Node API with an inline rule',
    smoke: `(async () => {
      const { ESLint } = require('eslint');
      const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ rules: { 'no-unused-vars': 'error' } }] });
      const [result] = await eslint.lintText('const a = 1;');
      return 'eslint ' + require('eslint/package.json').version + ' messages=' + result.messages.length;
    })()`,
  },
  {
    name: 'tailwind-3',
    packages: [{ name: 'tailwindcss', range: '3' }, { name: 'postcss', range: 'latest' }],
    note: 'Tailwind v3 is pure JavaScript. Tailwind v4 needs the native lightningcss binary and is not supported here',
    smoke: `(async () => {
      const postcss = require('postcss');
      const tailwind = require('tailwindcss');
      const result = await postcss([tailwind({ content: [], theme: {}, plugins: [] })]).process('@tailwind base;@tailwind utilities;', { from: undefined });
      return 'tailwind ' + require('tailwindcss/package.json').version + ' compiled css=' + result.css.length + ' bytes';
    })()`,
  },
];

const INJECT = `globalThis.__inject = (prefix, files) => {
  const touched = new Set();
  for (const name of Object.keys(files)) {
    let current = prefix + name;
    while (current !== '/' && current !== '') { const parent = current.slice(0, current.lastIndexOf('/')) || '/'; touched.add(parent); current = parent; }
  }
  for (const dir of touched) if (!__internal.getFS()[dir]) __internal.getFS()[dir] = { d: true, m: Date.now() };
  for (const [name, value] of Object.entries(files)) __internal.getFS()[prefix + name] = { c: value, m: Date.now() };
  return Object.keys(files).length;
};
globalThis.once = (emitter, event) => new Promise((resolve, reject) => {
  emitter.once(event, (...args) => resolve(args[0]));
  if (event === 'listening' && emitter.once) emitter.once('error', reject);
});
globalThis.probe = (port, requestPath, options = {}) => new Promise((resolve, reject) => {
  const req = CORE.http.request({ port, path: requestPath, method: options.method || 'GET', headers: options.headers }, res => {
    let text = ''; res.setEncoding('utf8');
    res.on('data', chunk => text += chunk);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
  });
  req.on('error', reject);
  if (options.body) req.write(options.body);
  req.end();
});`;

const formatError = failure => {
  const code = failure?.code ? failure.code + ': ' : '';
  return code + String(failure?.message || failure).split('\n')[0].slice(0, 220);
};

const run = async ({ only, write, check }) => {
  // Boot through the real init path so /.beownir/runtime holds the esbuild shim and Rollup WASM.
  const rt = await initToolchain(loadRuntime());
  rt.evaluate(INJECT);
  rt.evaluate("CORE.process = CORE.process || processObj; CORE.http = CORE.http || http;");
  /* Each row starts from a clean project: twenty dependency trees do not fit in
   * the virtual quota, and a leftover tree would hide a resolution failure. */
  const resetProject = () => rt.evaluate(`(() => {
    let removed = 0;
    for (const key of Object.keys(__internal.getFS())) {
      if (key === '/project/node_modules' || key.startsWith('/project/node_modules/') || key === '/project/smoke' || key.startsWith('/project/smoke/')) { delete __internal.getFS()[key]; removed++; }
    }
    return removed;
  })()`);
  const results = [];
  for (const profile of profiles) {
    if (only && !profile.name.includes(only)) continue;
    resetProject();
    const started = Date.now();
    const tree = await resolveTree(profile.packages);
    const { files, installed, failures } = await installTree(tree.packages);
    rt.sandbox.__inject('/project/', files);
    if (profile.files) rt.sandbox.__inject('/project/', profile.files);
    const versions = installed.filter(item => profile.packages.some(root => root.name === item.name)).map(item => item.name + '@' + item.version);
    let outcome, code;
    try {
      if (profile.command) {
        const result = await rt.run(profile.command);
        outcome = (result.output || '').trim() || 'command completed with exit ' + result.code;
        code = result.code;
        if (code === 0 && profile.verify) {
          const verified = await rt.evaluate(`(() => { const require = CORE.module.createRequire('/project/index.js'); return (${profile.verify}); })()`);
          outcome += '; ' + String(verified);
        }
      } else {
        const value = await rt.evaluate(`(async () => { const require = CORE.module.createRequire('/project/index.js'); const http = CORE.http; return (${profile.smoke}); })()`);
        outcome = String(value); code = 0;
      }
    } catch (failure) { outcome = formatError(failure); code = 1; }
    results.push({ name: profile.name, passed: code === 0, detail: outcome, note: profile.note, packages: installed.length, versions, installFailures: failures.length, resolveFailures: tree.failures.length, ms: Date.now() - started });
    console.log(`${code === 0 ? '  ok  ' : ' FAIL '} ${profile.name.padEnd(9)} ${outcome}`);
  }
  const passed = results.filter(result => result.passed).length;
  console.log(`\n${passed}/${results.length} frameworks ran inside the virtual runtime`);
  const document = { generatedAt: new Date().toISOString(), node: process.version, runtime: rt.evaluate('processObj.version'), results };
  if (write) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(document, null, 2) + '\n');
    console.log('wrote ' + path.relative(root, baselinePath));
  }
  if (check) {
    if (!fs.existsSync(baselinePath)) { console.error('no baseline: run --write first'); process.exitCode = 1; return; }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const regressions = baseline.results.filter(before => before.passed && results.some(after => after.name === before.name && !after.passed));
    if (regressions.length) { console.error('regressed: ' + regressions.map(item => item.name).join(', ')); process.exitCode = 1; }
    else console.log('no framework regressed against ' + path.relative(root, baselinePath));
  }
  return results;
};

const args = process.argv.slice(2);
const only = args.find(argument => argument.startsWith('--only='))?.slice('--only='.length);
await run({ only, write: args.includes('--write'), check: args.includes('--check') });
