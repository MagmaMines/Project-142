// Boots the embedded worker runtime once in a VM so tests can drive the real
// compatibility layer, filesystem and virtual shell instead of a copy.
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readSite, scriptById } from './embedded.mjs';

let cached = null;

/* Boots the worker runtime. `options.globals` replaces or removes browser
 * globals *before* the runtime source runs, which is how the degraded-browser
 * tests simulate a worker without WebCrypto, CompressionStream, OPFS, caches,
 * localStorage or fetch. `options.keep` drops the instance instead of caching
 * it, so a test can boot several environments in one process. */
export function loadRuntime(options = {}) {
  const custom = options.globals || options.mutate || options.keep;
  if (!custom && cached) return cached;
  const html = readSite();
  const source = scriptById(html, 'runtimeSource');
  const pakoSource = scriptById(html, 'pakoSource');
  const posts = [];
  const listeners = new Map();
  const self = {
    postMessage: message => posts.push(message),
    addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    performance, crypto: crypto.webcrypto, console,
    navigator: { hardwareConcurrency: 4, userAgent: 'beownir-test' },
    location: { href: 'https://ide.example.test/' },
  };
  self.self = self;
  self.globalThis = self;
  self.window = self;
  self.fetch = () => Promise.reject(new Error('offline test'));
  const sandbox = {
    ...self,
    self,
    Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, Blob,
    // WHATWG networking classes the browser gives every worker.
    Request, Response, Headers, FormData,
    structuredClone, atob, btoa, WeakRef, FinalizationRegistry,
    // Worker globals a browser provides; the runtime may re-export them.
    ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy,
    CompressionStream, DecompressionStream, TextEncoderStream, TextDecoderStream,
    MessageChannel, MessagePort, EventTarget, Event, AbortSignal,
    // SharedArrayBuffer and Atomics come from the VM context itself, exactly as
    // a cross-origin-isolated worker exposes them. A degraded scenario removes
    // them through options.globals rather than changing the default surface.
    // Node 22 (and every browser worker) has these; the runtime re-exports them.
    WebSocket, MessageEvent, CloseEvent: globalThis.CloseEvent, Blob: globalThis.Blob,
    fetch: self.fetch,
    crypto: crypto.webcrypto,
    console,
  };
  sandbox.globalThis = sandbox;
  // A worker's `self` *is* the global object, so assignments like
  // `self.console = mkConsole()` must land on the context, not on a copy.
  // The runtime does exactly that to install its terminal-backed console.
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.__hostTextEncoder = new TextEncoder();
  if (options.mutate) options.mutate(sandbox);
  for (const [name, value] of Object.entries(options.globals || {})) {
    if (value === undefined) delete sandbox[name];
    else sandbox[name] = value;
  }
  vm.createContext(sandbox);
  /* Contextifying restores intrinsics such as SharedArrayBuffer that were only
   * deleted from the sandbox object, so a requested removal is applied again
   * inside the context, where `typeof` actually reads it. */
  for (const [name, value] of Object.entries(options.globals || {})) {
    if (value !== undefined) continue;
    vm.runInContext('try { Object.defineProperty(globalThis, ' + JSON.stringify(name) + ', { value: undefined, configurable: true, writable: true }); } catch {}', sandbox);
  }
  // TextEncoder in a browser creates Uint8Arrays of the *same* realm, so code
  // like `new TextEncoder().encode('') instanceof Uint8Array` holds. Passing the
  // host class into the VM broke that invariant and made Vite refuse to boot.
  vm.runInContext(`globalThis.TextEncoder = class TextEncoder {
    constructor(){ this.encoding = 'utf-8'; }
    encode(input = '') { const bytes = __hostTextEncoder.encode(String(input)); const copy = new Uint8Array(bytes.length); copy.set(bytes); return copy; }
    encodeInto(input, destination) { const bytes = this.encode(input); destination.set(bytes.subarray(0, destination.length)); return { read: input.length, written: Math.min(bytes.length, destination.length) }; }
  };`, sandbox);
  vm.runInContext(
    source + '\n;globalThis.__internal={CORE,UTIL,OS,PATH,URLMOD,CRYPTO,ZLIB,STREAM,processObj,FS,getFS:()=>FS,splitArgs,executeLine,executeCommand,runCommand,SHELL,shellQuote,LIMITS,WORKSPACE_QUOTA,workspaceBudgetFromQuota,applyWorkspaceBudget,applyWorkspaceLimits,refreshWorkspaceBudget,quotaMessage};',
    sandbox,
    { filename: 'runtime-source.js' },
  );
  const internal = sandbox.__internal;
  internal.evaluate = code => vm.runInContext(code, sandbox);
  internal.FS['/.beownir/runtime/pako.js'] = { c: pakoSource };
  // The host normally sends a project through the init message; tests seed one.
  if (!internal.FS['/project']) internal.FS['/project'] = { d: true, m: Date.now() };
  if (!internal.FS['/project/package.json']) internal.FS['/project/package.json'] = { c: JSON.stringify({ name: 'demo', version: '1.0.0', scripts: {} }, null, 2) + '\n', m: Date.now() };
  internal.evaluate("CWD = '/project'; processObj.env.PWD = '/project';");
  internal.posts = posts;
  internal.listeners = listeners;
  internal.sandbox = sandbox;

  /** Runs a command line the way the terminal does and captures its output. */
  internal.run = async (line) => {
    const from = posts.length;
    const code = await internal.executeLine(String(line));
    const messages = posts.slice(from);
    const stdout = messages.filter(message => message.type === 'stdout').map(message => String(message.data)).join('');
    const stderr = messages.filter(message => message.type === 'stderr').map(message => String(message.data)).join('');
    return { code, stdout, stderr, output: stdout + stderr, messages };
  };

  // A miniature virtual kernel: the worker's `listen()`/`ps`/`kill` go through
  // kernelCall, so answering it here exercises the same production code path a
  // browser would, instead of a test-only shortcut.
  const kernelPorts = new Map();
  const reply = (id, result, error) => {
    try { sandbox.self.onmessage({ data: { type: 'kernel-reply', id, result, error } }); } catch (failure) { console.error('kernel reply failed', failure); }
  };
  // Ports served by "another virtual process": the kernel relay answers for them.
  const remoteServers = new Map();
  const kernel = message => {
    if (message.type !== 'kernel-call') return false;
    const { id, op, data } = message;
    try {
      if (op === 'http') {
        const port = Number(data?.port);
        const handler = remoteServers.get(port);
        if (!handler) { reply(id, null, { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:' + port }); return true; }
        const result = handler({ url: data.url, method: data.method, headers: data.headers || {}, body: data.body ? Buffer.from(data.body) : null }) || {};
        reply(id, { status: result.status || 200, statusMessage: result.statusMessage, headers: result.headers || {}, body: result.body ? Buffer.from(result.body) : new Uint8Array(0) });
        return true;
      }
      if (op === 'bind-http') {
        // Mirror the page kernel: listen(0) asks for an ephemeral port, and
        // silently binding 3000 made `server.address().port` wrong in tests.
        let port = Number(data?.port);
        if (!port) { port = 30000; while (kernelPorts.has(port) && port < 65535) port += 1; }
        if (kernelPorts.has(port)) { reply(id, null, { code: 'EADDRINUSE', message: 'Virtual port already in use: ' + port }); return true; }
        kernelPorts.set(port, id);
        reply(id, { port });
        return true;
      }
      if (op === 'unbind-http') { kernelPorts.delete(Number(data?.port)); reply(id, {}); return true; }
      // The filesystem barrier: the kernel acknowledges that synced files landed.
      if (op === 'barrier') { reply(id, { epoch: 1 }); return true; }
      // A full snapshot of the shared tree, the way the IDE kernel answers it.
      if (op === 'fs-snapshot') {
        const files = {};
        // init replaces the filesystem object, so read the live one, and pack binary
        // contents the way the host does for the wire.
        for (const [path, entry] of Object.entries(internal.getFS())) {
          if (path.startsWith('/.beownir')) continue;
          const content = entry?.c;
          const packed = typeof content === 'string' || content === undefined ? (content ?? '') : '__BEOWNIR_WASM64__:' + Buffer.from(content).toString('base64');
          files[path] = entry && entry.d ? { d: true } : { c: packed };
        }
        reply(id, { files, versions: {}, epoch: 1 });
        return true;
      }
      if (op === 'ps') { reply(id, [{ pid: 1, ppid: 0, state: 'running', command: 'beownir', ports: [...kernelPorts.keys()] }]); return true; }
      if (op === 'kill') { reply(id, {}); return true; }
      reply(id, null, { code: 'ENOSYS', message: 'Unsupported virtual syscall in tests: ' + op });
      return true;
    } catch (failure) { reply(id, null, { code: 'ERR_KERNEL', message: String(failure?.message || failure) }); return true; }
  };

  internal.kernelPorts = kernelPorts;
  internal.kernel = kernel;
  internal.serveRemote = (port, handler) => { remoteServers.set(Number(port), handler); return { close: () => remoteServers.delete(Number(port)) }; };
  // Route every postMessage through the miniature kernel first.
  sandbox.self.postMessage = message => {
    if (message && typeof message === 'object' && kernel(message)) { posts.push(message); return; }
    posts.push(message);
  };

  const initial = Object.keys(internal.FS);
  internal.restore = () => {
    for (const key of Object.keys(internal.FS)) if (!initial.includes(key)) delete internal.FS[key];
    internal.evaluate("CWD = '/project'; SHELL.history.length = 0; SHELL.lastCode = 0;");
    posts.length = 0;
  };
  if (!options.keep) cached = internal;
  return internal;
}

/**
 * Boots the toolchain the way the host does: the same `init` message carries the
 * embedded pako, esbuild JS and (decompressed) esbuild WASM, and the worker mounts them
 * under /.beownir/runtime/ together with the esbuild shim and the Rollup WASM build.
 */
export async function initToolchain(rt) {
  const { readSite, scriptById } = await import('./embedded.mjs');
  const zlib = await import('node:zlib');
  const site = readSite();
  await rt.sandbox.self.onmessage({
    data: {
      type: 'init',
      files: {},
      versions: {},
      embeddedPako: scriptById(site, 'pakoSource'),
      embeddedEsbuildBrowser: Buffer.from(scriptById(site, 'esbuildBrowser').trim(), 'base64').toString('utf8'),
      embeddedEsbuildWasm: new Uint8Array(zlib.gunzipSync(Buffer.from(scriptById(site, 'esbuildWasm').trim(), 'base64')))
    }
  });
  return rt;
}
