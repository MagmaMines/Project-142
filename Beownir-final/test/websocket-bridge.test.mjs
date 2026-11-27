import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

/* The page's WebSocket reaches a virtual port through the worker's RFC 6455 client. This test
 * runs the worker's real message handler against a minimal in-runtime server that checks the
 * client's masking and answers with unmasked frames, then reads the events the page would get. */

/* Forward every worker message to the runtime's own handler, and keep the websocket events. */
function captureWsEvents(runtime) {
  const original = runtime.sandbox.self.postMessage;
  runtime.sandbox.self.postMessage = message => {
    if (message && message.type === 'wsevent') runtime.sandbox.__events.push(message);
    if (typeof original === 'function') return original(message);
  };
}

const rt = await initToolchain(loadRuntime());

test('a page WebSocket opens, echoes a text frame, and closes through the worker client', async () => {
  rt.sandbox.__events = [];
  await rt.evaluate(`(async () => {
    const http = CORE.http;
    const server = http.createServer(() => {});
    server.on('upgrade', (request, socket) => {
      let pending = Buffer.alloc(0);
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
      const reply = (opcode, payload) => socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 6) {
          const opcode = pending[0] & 15, masked = (pending[1] & 128) !== 0, length = pending[1] & 127;
          if (!masked) throw new Error('client frames must be masked');
          if (pending.length < 6 + length) return;
          const mask = pending.subarray(2, 6), body = Buffer.alloc(length);
          for (let i = 0; i < length; i++) body[i] = pending[6 + i] ^ mask[i & 3];
          pending = pending.subarray(6 + length);
          if (opcode === 1) reply(1, body);
          if (opcode === 8) { reply(8, body); socket.end(); }
        }
      });
    });
    await new Promise(resolve => server.listen(3341, '127.0.0.1', resolve));
    globalThis.__wsServer = server;
  })()`);

  const sandbox = rt.sandbox;
  captureWsEvents(rt);
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'open', id: 'ws-1', port: 3341, url: '/hmr', protocols: ['vite-hmr'] } });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('timed out waiting for ' + label + ': ' + JSON.stringify(sandbox.__events));
  };
  await waitFor(() => sandbox.__events.some(e => e.event === 'open'), 'open');
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'send', id: 'ws-1', data: 'ping', binary: false } });
  await waitFor(() => sandbox.__events.some(e => e.event === 'message'), 'echo');
  await sandbox.self.onmessage({ data: { type: 'ws', op: 'close', id: 'ws-1', code: 1000, reason: 'done' } });
  await waitFor(() => sandbox.__events.some(e => e.event === 'close'), 'close');

  const events = sandbox.__events.map(e => ({ event: e.event, data: e.data, protocol: e.protocol, code: e.code }));
  assert.deepEqual(events.map(e => e.event), ['open', 'message', 'close']);
  assert.equal(events[1].data, 'ping');
  assert.equal(events[0].protocol, '');
  assert.equal(events[2].code, 1000);
  rt.evaluate('globalThis.__wsServer.close()');
});

test('a WebSocket to a port nobody listens on reports an error and closes', async () => {
  rt.sandbox.__events = [];
  captureWsEvents(rt);
  await rt.sandbox.self.onmessage({ data: { type: 'ws', op: 'open', id: 'ws-2', port: 3399, url: '/', protocols: [] } });
  for (let i = 0; i < 100 && !rt.sandbox.__events.some(e => e.event === 'close'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const kinds = rt.sandbox.__events.map(e => e.event);
  assert.ok(kinds.includes('error'), 'an error event must be sent');
  assert.equal(kinds[kinds.length - 1], 'close');
});

test('preview VirtualWebSocket handles Blob, ArrayBuffer, primitives, and FIFO close ordering', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const { fileURLToPath } = await import('node:url');
  const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'o', 'runtime', 'preview-bridge.js');
  const source = fs.readFileSync(bridgePath, 'utf8');

  const sent = [];
  const listeners = new Map();
  let portRef = null;
  const fakeWindow = {
    __BEOWNIR_PREVIEW_CONFIG__: { port: 5173, path: '/', token: 'tok' },
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    history: { pushState() {}, replaceState() {} },
    location: { href: 'http://localhost:5173/', pathname: '/', search: '', hash: '' },
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [] },
    XMLHttpRequest: function() {},
    WebSocket: function() {},
  };
  const fakePort = {
    start() {},
    postMessage(msg) { sent.push(msg); },
    onmessage: null,
  };
  const context = {
    window: fakeWindow,
    parent: fakeWindow,
    document: fakeWindow.document,
    location: fakeWindow.location,
    history: fakeWindow.history,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    Blob,
    Request,
    Response,
    Headers,
    DOMException,
    EventTarget,
    Event: typeof Event !== 'undefined' ? Event : class Event { constructor(t) { this.type = t; } },
    MessageEvent: typeof MessageEvent !== 'undefined' ? MessageEvent : class MessageEvent { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    Uint8Array,
    ArrayBuffer,
    SharedArrayBuffer,
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.runInNewContext(source, context, { filename: 'preview-bridge.js' });
  for (const fn of listeners.get('message') || []) {
    fn({ source: fakeWindow, data: { type: 'beownir-preview', token: 'tok' }, ports: [fakePort] });
  }
  await new Promise(resolve => setTimeout(resolve, 10));

  const ws = new fakeWindow.WebSocket('ws://localhost:5173/ws');
  await new Promise(resolve => setTimeout(resolve, 10));
  fakePort.onmessage({ data: { type: 'wsevent', id: ws.id, event: 'open', protocol: '' } });

  ws.send(new Blob([new Uint8Array([0xde, 0xad, 0xbe, 0xef])]));
  ws.send(12345);
  ws.send(new Uint8Array([1, 2, 3, 4]).subarray(1, 3).buffer.slice(1, 3));
  ws.close(1000, 'bye');

  await new Promise(resolve => setTimeout(resolve, 40));
  const wsMsgs = sent.filter(m => m.type === 'ws');
  assert.deepEqual(wsMsgs.map(m => m.op), ['open', 'send', 'send', 'send', 'close']);
  assert.equal(wsMsgs[1].binary, true);
  assert.deepEqual(Array.from(wsMsgs[1].data), [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(wsMsgs[2].binary, false);
  assert.equal(wsMsgs[2].data, '12345');
  assert.equal(wsMsgs[3].binary, true);
  assert.deepEqual(Array.from(wsMsgs[3].data), [2, 3]);
  assert.equal(wsMsgs[4].code, 1000);
});

test('preview module rewriter ignores strings, comments, regexes, templates, and member import() while rewriting ESM imports', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const { fileURLToPath } = await import('node:url');
  const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'o', 'runtime', 'preview-bridge.js');
  const source = fs.readFileSync(bridgePath, 'utf8');

  const fetched = [];
  const listeners = new Map();
  let portRef = null;
  const fakeWindow = {
    __BEOWNIR_PREVIEW_CONFIG__: { port: 3300, path: '/__web/index.html', token: 'tok-mod' },
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    history: { pushState() {}, replaceState() {} },
    location: { href: 'http://localhost:3300/__web/index.html', pathname: '/__web/index.html', search: '', hash: '' },
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [] },
    XMLHttpRequest: function() {},
    WebSocket: function() {},
  };

  const modules = new Map([
    ['/__web/entry.jsx', [
      "import realDep, { x as from } from './dep.js';",
      "import './side.js';",
      "export * from './reexport.js';",
      'const componentName2 = "App";',
      'const err1 = "Render error from \\"" + componentName2 + "\\" component";',
      "const err2 = 'Try import \"' + componentName2 + '\" directly';",
      'const err3 = "import(\'./fake-string.js\')";',
      '// import fake from "./fake-line-comment.js"',
      '/* export * from "./fake-block-comment.js"; import("./fake-comment-dyn.js"); */',
      'const re1 = /\\bfrom\\s+["\']([^"\'\\n]+)["\']/g;',
      'const re2 = /import\\s*\\(/g;',
      'const tpl = `prefix from "./fake-tpl.js" import("./fake-tpl-dyn.js") ${async () => import("/__web/dyn.js")}`;',
      'const holder = { import(v) { return v; }, from: "./fake-obj.js" };',
      'const direct = holder.import("./fake-method.js");',
      'const opt = holder?.import("./fake-opt.js");',
      'export default { realDep, err1, err2, err3, re1, re2, tpl, direct, opt, from };',
    ].join('\n')],
    ['/__web/dep.js', 'export const x = 1; export default "DEP";'],
    ['/__web/side.js', 'export const side = true;'],
    ['/__web/reexport.js', 'export const reexported = 42;'],
    ['/__web/dyn.js', 'export const dyn = "OK";'],
  ]);

  const fakePort = {
    start() {},
    postMessage(msg) {
      if (msg.type === 'request') {
        fetched.push(msg.path);
        const bodyText = modules.get(msg.path);
        queueMicrotask(() => {
          portRef.onmessage({
            data: {
              id: msg.id,
              status: bodyText !== undefined ? 200 : 404,
              headers: { 'content-type': 'text/javascript' },
              body: new TextEncoder().encode(bodyText !== undefined ? bodyText : 'File not found: ' + msg.path),
            },
          });
        });
      }
    },
    onmessage: null,
  };
  portRef = fakePort;

  const importedUrls = [];
  fakeWindow.__BEOWNIR_PREVIEW_CONFIG__.importDataUrl = async specifier => {
    importedUrls.push(specifier);
    const b64 = specifier.slice('data:text/javascript;base64,'.length);
    return { default: Buffer.from(b64, 'base64').toString('utf8') };
  };
  const context = {
    window: fakeWindow,
    parent: fakeWindow,
    document: fakeWindow.document,
    location: fakeWindow.location,
    history: fakeWindow.history,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    Blob,
    Request,
    Response,
    Headers,
    DOMException,
    EventTarget,
    Event: typeof Event !== 'undefined' ? Event : class Event { constructor(t) { this.type = t; } },
    MessageEvent: typeof MessageEvent !== 'undefined' ? MessageEvent : class MessageEvent { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    btoa: str => Buffer.from(str, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.runInNewContext(source, context, { filename: 'preview-bridge.js' });
  for (const fn of listeners.get('message') || []) {
    fn({ source: fakeWindow, data: { type: 'beownir-preview', token: 'tok-mod' }, ports: [fakePort] });
  }
  await new Promise(resolve => setTimeout(resolve, 10));

  const mod = await fakeWindow.__beownirDynamicImport('/__web/entry.jsx');
  const rewritten = mod.default;
  assert.deepEqual(fetched.sort(), ['/__web/dep.js', '/__web/entry.jsx', '/__web/reexport.js', '/__web/side.js']);
  assert.ok(rewritten.includes('err1 = "Render error from \\"" + componentName2 + "\\" component"'), 'string concatenation stays untouched');
  assert.ok(rewritten.includes("err2 = 'Try import \"' + componentName2 + '\" directly'"), 'single-quoted string stays untouched');
  assert.ok(rewritten.includes('err3 = "import(\'./fake-string.js\')"'), 'dynamic import inside string stays untouched');
  assert.ok(rewritten.includes('globalThis.__beownirDynamicImport("/__web/dyn.js")'), 'template interpolation dynamic import is rewritten');
  assert.ok(rewritten.includes('const holder = { import(v) { return v; }'), 'method definition import(v) stays untouched');
  assert.ok(rewritten.includes('holder.import("./fake-method.js")'), 'member call .import() stays untouched');
  assert.ok(rewritten.includes('holder?.import("./fake-opt.js")'), 'optional chaining ?.import() stays untouched');
  assert.equal(importedUrls.length, 1);
  // Syntax-check the rewritten ES module via Node's parser (--check .mjs).
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const tmpMjs = path.join(os.tmpdir(), 'beownir-rewritten-' + process.pid + '.mjs');
  fs.writeFileSync(tmpMjs, rewritten);
  try { execFileSync(process.execPath, ['--check', tmpMjs], { stdio: 'pipe' }); }
  finally { fs.rmSync(tmpMjs, { force: true }); }
});
