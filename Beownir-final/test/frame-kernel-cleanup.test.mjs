import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MessageChannel, MessagePort } from 'node:worker_threads';
import { readSite, scriptById } from './helpers/embedded.mjs';

/* Regression test for the frame-kernel worker-routing cleanup: when a virtual
 * process or thread exits, the WebSocket sessions it owns must be closed on
 * the host so a finished worker's sockets never outlive it. The kernel runs
 * as a browser worker global (window.addEventListener, worker.onmessage,
 * new Worker), so it is executed in a Node vm sandbox with those primitives
 * stubbed, and the spawned workers run the real runtime module embedded in
 * the single-file site. */

const KERNEL_SOURCE = scriptById(readSite(), 'runtimeFrameSource');
const WORKER_SOURCE = scriptById(readSite(), 'runtimeSource');
const PAKO_SOURCE = scriptById(readSite(), 'pakoSource');

function unrefTimer(fn, ms, ...args) {
  const timer = setTimeout(fn, ms, ...args);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function createKernel() {
  const hostMessages = [];
  const workerErrors = [];
  const spawned = [];
  const onmessageHandlers = [];
  const sourceByURL = Object.create(null);
  let blobSeq = 0;

  class TestBlob {
    constructor(parts, options) {
      this.parts = Array.isArray(parts) ? parts : [parts];
      this.type = (options && options.type) || '';
    }
    text() { return Promise.resolve(this.parts.map(String).join('')); }
  }

  class UnrefMessageChannel {
    constructor() {
      const channel = new MessageChannel();
      this.port1 = channel.port1;
      this.port2 = channel.port2;
      this.port1.unref();
      this.port2.unref();
    }
  }

  class WebSocketStub {
    constructor(url, protocols) {
      this.url = url;
      this.readyState = 0;
      this.protocols = protocols;
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  }

  // The kernel's host channel: the kernel sets host.onmessage and posts
  // results back through host.postMessage.
  const host = {
    onmessage: null,
    closed: false,
    postMessage(data, transfer) { hostMessages.push(data); },
    close() { this.closed = true; },
    start() {},
    deliver(data) { if (this.onmessage) this.onmessage({ data }); },
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout: unrefTimer,
    clearTimeout,
    setInterval: (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clearInterval,
    setImmediate: (fn, ...args) => { const t = setImmediate(fn, ...args); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clearImmediate,
    queueMicrotask,
    atob, btoa, TextEncoder, TextDecoder, URL, URLSearchParams,
    performance, Event, EventTarget, AbortController, AbortSignal,
    crypto: globalThis.crypto, Atomics, SharedArrayBuffer,
    MessageChannel: UnrefMessageChannel,
    MessagePort,
    WebSocket: WebSocketStub,
    Blob: TestBlob,
    structuredClone,
    queue: null,
    state: null,
    pako: null,
    window: {
      addEventListener(type, handler) { if (type === 'message') onmessageHandlers.push(handler); },
    },
    parent: { postMessage() {} },
    self: {
      onmessage: null,
      addEventListener() {},
      removeEventListener() {},
      postMessage() {},
    },
  };
  sandbox.window.self = sandbox.self;
  sandbox.globalThis = sandbox;
  sandbox.URL = Object.assign(function URL(...args) { return new globalThis.URL(...args); }, globalThis.URL);
  sandbox.URL.createObjectURL = blob => {
    const url = 'blob:beownir-test/' + (++blobSeq);
    Promise.resolve(blob.text()).then(text => { sourceByURL[url] = text; });
    return url;
  };
  sandbox.URL.revokeObjectURL = () => {};

  class KernelWorker {
    constructor(url, options) {
      this.options = options || {};
      this.name = this.options.name || 'worker';
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.replies = [];
      const source = sourceByURL[String(url)] || WORKER_SOURCE;
      const script = new vm.Script(source, { filename: 'kernel-worker.js' });
      const self_ = {
        onmessage: null,
        addEventListener() {},
        removeEventListener() {},
        postMessage(data) {
          const handler = this.__kernelOnmessage;
          if (handler) setImmediate(() => { try { handler({ data }); } catch (err) { workerErrors.push(err); } });
        },
      };
      self_.globalThis = self_;
      // A real worker's self exposes the global scope; inherit the sandbox
      // globals (timers, crypto, TextEncoder, ...) through the prototype.
      Object.setPrototypeOf(self_, sandbox);
      const context = vm.createContext(Object.assign({}, sandbox, {
        self: self_,
        window: Object.assign({}, sandbox.window, {
          addEventListener() {},
          postMessage: self_.postMessage,
        }),
        parent: sandbox.parent,
        onmessage: null,
      }));
      context.self = self_;
      this.context = context;
      this.workerSelf = self_;
      // The kernel sets worker.onmessage; worker self.postMessage delivers
      // back into it, mirroring browser worker messaging.
      self_.__kernelOnmessage = event => { if (this.onmessage) this.onmessage(event); };
      try {
        script.runInContext(context, { timeout: 5000 });
      } catch (err) {
        workerErrors.push(err);
      }
      spawned.push(this);
    }

    // Kernel -> worker message. Browser postMessage is async; mimic that.
    postMessage(data, transfer) {
      if (this.terminated) return;
      // Record kernel replies so tests can synchronize on syscall results.
      if (data && data.type === 'kernel-reply') this.replies.push(data);
      // Reply blackhole: with it on, kernel replies never reach the module, so
      // an in-flight kernel-call keeps the worker's message loop alive and the
      // test controls exactly when the worker exits.
      if (this.dropReplies && data && data.type === 'kernel-reply') return;
      const handler = this.context.self && this.context.self.onmessage;
      if (handler) setImmediate(() => { try { handler({ data }); } catch (err) { workerErrors.push(err); } });
    }

    terminate() {
      this.terminated = true;
      this.onmessage = null;
      this.workerSelf.__kernelOnmessage = null;
    }

    // Worker -> kernel message (the kernel reads worker.onmessage).
    sendToKernel(data) {
      if (this.terminated || !this.onmessage) return;
      setImmediate(() => { try { this.onmessage({ data }); } catch (err) { workerErrors.push(err); } });
    }

    sendKernelCall(op, data) {
      this.sendToKernel({ type: 'kernel-call', id: 'kc-' + (++KernelWorker.seq), op, data });
    }
  }
  KernelWorker.seq = 0;

  sandbox.Worker = KernelWorker;

  const context = vm.createContext(sandbox);
  new vm.Script(KERNEL_SOURCE).runInContext(context);

  function dispatch(message) {
    const event = { source: sandbox.parent, data: message, ports: [host] };
    for (const handler of [...onmessageHandlers]) handler(event);
  }

  async function waitFor(check, message, timeout = 4000) {
    const started = Date.now();
    for (;;) {
      if (check()) return;
      if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + message);
      await new Promise(r => setTimeout(r, 10));
    }
  }

  const text = () => hostMessages.map(m => JSON.stringify(m)).join('\n');
  const findWorker = name => spawned.find(w => w.name === name) || null;
  const replyBound = (worker, port) => worker.replies.some(r => r.result && Number(r.result.port) === port);

  return { sandbox, host, hostMessages, workerErrors, spawned, dispatch, waitFor, text, findWorker, replyBound };
}

function bootKernel(kernel) {
  kernel.dispatch({
    type: 'beownir-runtime',
    source: WORKER_SOURCE,
    kind: 'thread',
  });
  return kernel.waitFor(() => /"type":"connected"/.test(kernel.text()), 'kernel connected');
}

function initRuntime(kernel) {
  kernel.host.deliver({
    type: 'init',
    files: { '/project': { d: true } },
    versions: {},
    embeddedEsbuildWasm: new ArrayBuffer(16),
    embeddedEsbuildBrowser: null,
    embeddedPako: PAKO_SOURCE,
  });
  return kernel.waitFor(() => /"type":"ready"/.test(kernel.text()), 'process 1 ready');
}

test('frame kernel closes WebSocket sessions owned by an exited thread', async () => {
  const kernel = createKernel();
  await bootKernel(kernel);
  await initRuntime(kernel);

  const shell = kernel.findWorker('Beownir process 1');
  assert.ok(shell, 'the kernel should have spawned the IDE shell worker');

  // The shell spawns a worker_thread; the thread binds a virtual port.
  shell.sendToKernel({ type: 'thread-spawn', threadId: 7 });
  await kernel.waitFor(() => kernel.findWorker('Beownir thread 7'), 'thread worker spawned');
  const thread = kernel.findWorker('Beownir thread 7');
  // Keep the thread's message loop alive so the claim and the exit trigger are
  // deterministic (an in-flight kernel-call never resolves).
  thread.dropReplies = true;
  thread.sendKernelCall('bind-http', { port: 8080 });
  await kernel.waitFor(() => kernel.replyBound(thread, 8080), 'port bound by the thread');

  // The host opens a WebSocket against the thread's port: the kernel claims
  // the session for the thread actor synchronously, then the shell terminates
  // the thread. The claim and the cleanup both happen kernel-side.
  kernel.host.deliver({ type: 'ws', op: 'open', id: 'ws-1', port: 8080, url: '/chat' });
  shell.sendToKernel({ type: 'thread-terminate', threadId: 7 });
  await kernel.waitFor(() => kernel.hostMessages.some(m => m.type === 'wsevent' && m.id === 'ws-1' && m.event === 'close' && /The virtual thread exited\./.test(m.reason || '')), 'ws cleanup close');

  const closes = kernel.hostMessages.filter(m => m.type === 'wsevent' && m.event === 'close' && m.id === 'ws-1');
  assert.ok(closes.length >= 1, 'exiting thread must close its WebSocket sessions');
  const cleanup = closes.find(c => /The virtual thread exited\./.test(c.reason || ''));
  assert.ok(cleanup, 'the cleanup close must explain the exiting thread');
  assert.equal(cleanup.code, 1006);
  assert.ok(thread.terminated, 'the thread worker must be terminated');
});

test('frame kernel closes WebSocket sessions owned by an exited process', async () => {
  const kernel = createKernel();
  await bootKernel(kernel);
  await initRuntime(kernel);

  const shell = kernel.findWorker('Beownir process 1');
  shell.sendKernelCall('spawn', { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: '/project', env: {}, prepared: [] });
  await kernel.waitFor(() => kernel.findWorker('Beownir process 2'), 'child process spawned');
  const child = kernel.findWorker('Beownir process 2');
  // Keep the child's message loop alive (its in-flight init kernel-call never
  // resolves) so the session claim and the exit trigger are deterministic.
  child.dropReplies = true;
  // Bind the port, then claim the session while the child is still alive:
  // the listener registration is synchronized through the process table.
  child.sendKernelCall('bind-http', { port: 8080 });
  await kernel.waitFor(() => kernel.replyBound(child, 8080), 'port bound by the child');

  // The host opens a WebSocket against the child's port: the kernel claims
  // the session for the child actor synchronously, then the child reports its
  // own exit. The claim and the cleanup both happen kernel-side.
  kernel.host.deliver({ type: 'ws', op: 'open', id: 'ws-proc', port: 8080, url: '/chat' });
  child.sendToKernel({ type: 'kernel-exit', code: 0 });
  await kernel.waitFor(() => kernel.hostMessages.some(m => m.type === 'wsevent' && m.id === 'ws-proc' && m.event === 'close' && /The virtual process exited\./.test(m.reason || '')), 'ws cleanup close');

  const closes = kernel.hostMessages.filter(m => m.type === 'wsevent' && m.event === 'close' && m.id === 'ws-proc');
  assert.ok(closes.length >= 1, 'exiting process must close its WebSocket sessions');
  const cleanup = closes.find(c => /The virtual process exited\./.test(c.reason || ''));
  assert.ok(cleanup, 'the cleanup close must explain the exiting process');
  assert.equal(cleanup.code, 1006);
  assert.ok(child.terminated, 'the process worker must be terminated');
});

test('frame kernel terminates spawned workers when the shell exits', async () => {
  const kernel = createKernel();
  await bootKernel(kernel);
  await initRuntime(kernel);

  const shell = kernel.findWorker('Beownir process 1');
  shell.sendKernelCall('spawn', { command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], cwd: '/project', env: {}, prepared: [] });
  await kernel.waitFor(() => kernel.findWorker('Beownir process 2'), 'child process spawned');

  kernel.host.deliver({ type: 'terminate' });
  await kernel.waitFor(() => /"type":"kernel-stopped"/.test(kernel.text()), 'kernel stopped');

  assert.ok(kernel.spawned.length >= 2, 'the kernel should have spawned workers');
  for (const worker of kernel.spawned) assert.ok(worker.terminated, `worker ${worker.name} must be terminated`);
});
