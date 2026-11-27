import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadRuntime } from './helpers/runtime.mjs';
import { build } from '../tools/build-embed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rt = loadRuntime();

test.beforeEach(() => { rt.restore(); });

test('worker profiler has zero overhead when disabled and records spans + flushes when enabled', async () => {
  // Disabled by default
  assert.equal(rt.evaluate('PROFILER.enabled'), false);
  await rt.run('node -e "1 + 1"');
  assert.equal(rt.evaluate('PROFILER.spans.length'), 0);
  assert.equal(rt.posts.some(p => p.type === 'profiler-spans' || p.type === 'profiler-data'), false);

  // Enable via profiler start message
  await rt.sandbox.onmessage({ data: { type: 'profiler', action: 'start', maxSpans: 500 } });
  assert.equal(rt.evaluate('PROFILER.enabled'), true);
  await rt.runCommand('node -e "console.log(42)"', 'cmd-1');

  // Snapshot / collect via profiler message
  const beforeCollect = rt.posts.length;
  await rt.sandbox.onmessage({ data: { type: 'profiler', action: 'stop', collectId: 'c-1' } });
  assert.equal(rt.evaluate('PROFILER.enabled'), false);

  const flushed = rt.posts.slice(0, beforeCollect).filter(p => p.type === 'profiler-spans').flatMap(p => p.spans);
  const collected = rt.posts.slice(beforeCollect).filter(p => p.type === 'profiler-data' && p.collectId === 'c-1').flatMap(p => p.spans);
  const allSpans = flushed.concat(collected);
  assert.ok(allSpans.some(s => s.name === 'shell.command'), 'shell.command span recorded');
  assert.ok(allSpans.some(s => s.name === 'node.run'), 'node.run span recorded');
});

test('BeownirKernel profiler aggregates host and worker spans cleanly', async () => {
  const source = build();
  const posted = [];
  const fakeWindow = {
    document: {
      createElement() {
        const listeners = {};
        return {
          style: {},
          setAttribute() {},
          addEventListener(type, fn) { listeners[type] = fn; },
          remove() {},
          contentWindow: { postMessage() {} },
        };
      },
      body: { appendChild() {} },
      querySelector() { return null; },
    },
    performance,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    Headers,
    Response,
    URL,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    console,
  };
  const ctx = vm.createContext(fakeWindow);
  vm.runInContext(source, ctx);
  const kernel = ctx.BeownirKernel.create({ autostart: false });
  kernel._state = 'ready';
  kernel._ready.resolve(kernel);
  kernel._channel = { postMessage(msg) { posted.push(msg); } };

  await kernel.startProfile({ maxSpans: 100 });
  assert.equal(posted[posted.length - 1].type, 'profiler');
  kernel._recordHostSpan('kernel.run', 'shell', performance.now() - 10, { command: 'node a.js' });

  const stopPromise = kernel.stopProfile();
  const stopMsg = posted[posted.length - 1];
  assert.equal(stopMsg.type, 'profiler');
  assert.equal(stopMsg.action, 'stop');
  kernel._receive({
    type: 'profiler-report',
    id: stopMsg.id,
    report: {
      startedAt: Date.now() - 50,
      endedAt: Date.now(),
      spans: [
        { name: 'node.run', category: 'commands', startMs: 10, durationMs: 120 },
        { name: 'node.run', category: 'commands', startMs: 20, durationMs: 30 },
      ],
    },
  });
  const report = await stopPromise;
  assert.equal(report.summary.totalSpans, 3);
  assert.equal(report.summary.slowSpanCount, 1);
  assert.equal(report.aggregates['node.run'].count, 2);
  assert.equal(report.aggregates['node.run'].minMs, 30);
  assert.equal(report.aggregates['node.run'].maxMs, 120);
  assert.equal(report.aggregates['node.run'].avgMs, 75);
});

test('PreviewInspector enforces attach/detach/error semantics and round-trips messages cleanly', async () => {
  const source = build();
  const ctx = vm.createContext({
    document: { body: { appendChild() {} }, createElement() { return { style: {}, setAttribute() {}, addEventListener() {}, remove() {} }; } },
    MessageChannel,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, ctx);
  const { PreviewInspector, PreviewNotAttachedError, PreviewAgentUnavailableError } = ctx.BeownirKernel;

  const inspector = new PreviewInspector({ timeoutMs: 200 });
  await assert.rejects(() => inspector.ping(3000), err => err instanceof PreviewNotAttachedError && err.code === 'PREVIEW_NOT_ATTACHED');

  inspector.attach(3000, { contentWindow: null });
  await assert.rejects(() => inspector.ping(3000, { retry: false }), err => err instanceof PreviewAgentUnavailableError && err.code === 'PREVIEW_AGENT_UNAVAILABLE');

  // Round-trip over MessageChannel
  const fakeIframe = {
    contentWindow: {
      postMessage(payload, _origin, ports) {
        if (payload.type === 'beownir-inspect-request' && ports && ports[0]) {
          ports[0].postMessage({
            type: 'beownir-inspect-response',
            id: payload.id,
            port: 3000,
            ok: true,
            data: { ready: true, op: payload.op, params: payload.params },
          });
        }
      },
    },
  };
  inspector.attach(3000, fakeIframe, { token: 'tok-1' });
  assert.equal(inspector.isAttached(3000), true);

  const pingRes = await inspector.ping(3000);
  assert.equal(pingRes.ready, true);
  assert.equal(pingRes.op, 'ping');

  const actRes = await inspector.act(3000, { action: 'click', ref: 'e1' });
  assert.equal(actRes.params.action, 'click');
  assert.equal(actRes.params.ref, 'e1');

  inspector.detach(3000);
  assert.equal(inspector.isAttached(3000), false);
  inspector.destroy();
});

test('preview-bridge.js and coi-sw.js inspect handlers respond cleanly for DOM/console/act/snapshot ops', async () => {
  const bridgeSrc = fs.readFileSync(path.join(root, 'o', 'runtime', 'preview-bridge.js'), 'utf8');
  const listeners = { message: [] };
  const elButton = {
    tagName: 'BUTTON',
    id: 'btn',
    className: 'primary',
    innerText: 'Click me',
    isConnected: true,
    disabled: false,
    clicked: 0,
    attributes: [{ name: 'id', value: 'btn' }],
    getAttribute(k) { return k === 'id' ? 'btn' : null; },
    getBoundingClientRect() { return { x: 10, y: 20, width: 100, height: 32, top: 20, right: 110, bottom: 52, left: 10 }; },
    focus() {},
    click() { this.clicked++; },
    children: [],
  };
  const elInput = {
    tagName: 'INPUT',
    id: 'name',
    type: 'text',
    value: '',
    isConnected: true,
    disabled: false,
    attributes: [{ name: 'id', value: 'name' }],
    getAttribute(k) { return k === 'id' ? 'name' : k === 'placeholder' ? 'Your name' : null; },
    getBoundingClientRect() { return { x: 10, y: 60, width: 120, height: 28, top: 60, right: 130, bottom: 88, left: 10 }; },
    focus() {},
    dispatchEvent() {},
    children: [],
  };
  const bodyEl = {
    tagName: 'BODY',
    innerText: 'Hello Preview',
    scrollWidth: 800,
    scrollHeight: 600,
    children: [elButton, elInput],
  };
  const parentObj = {};
  const replies = [];
  const docObj = {
    readyState: 'complete',
    title: 'Bridge Test',
    documentElement: bodyEl,
    body: bodyEl,
    addEventListener() {},
    querySelector(sel) { return sel === '#btn' ? elButton : sel === '#name' ? elInput : null; },
    querySelectorAll() { return [elButton, elInput]; },
  };
  const winObj = {
    __BEOWNIR_PREVIEW_CONFIG__: { port: 3000, path: '/', token: 'secret', cookies: [] },
    innerWidth: 1024,
    innerHeight: 768,
    scrollX: 0,
    scrollY: 0,
    fetch: () => Promise.resolve(new Response('ok')),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent() {},
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: () => '' }; },
  };
  winObj.window = winObj;
  const ctx = vm.createContext({
    window: winObj,
    parent: { postMessage(msg) { replies.push(msg); } },
    document: docObj,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    Request,
    Response,
    Headers,
    Event,
    EventTarget,
    TextEncoder,
    TextDecoder,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    setTimeout,
    clearTimeout,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
  });
  ctx.parent = parentObj;
  parentObj.postMessage = msg => replies.push(msg);
  vm.runInContext(bridgeSrc, ctx);

  // Ready notification sent
  assert.ok(replies.some(r => r.type === 'beownir-inspect-ready' && r.port === 3000));

  const sendInspect = (id, op, params) => new Promise(resolve => {
    const replyPort = { postMessage: resolve };
    for (const fn of listeners.message) {
      fn({ source: parentObj, data: { type: 'beownir-inspect-request', id, op, params, token: 'secret' }, ports: [replyPort] });
    }
  });

  const interactive = await sendInspect('1', 'interactive', {});
  assert.equal(interactive.ok, true);
  assert.equal(interactive.data.length, 2);
  assert.equal(interactive.data[0].ref, 'e1');

  const clickRes = await sendInspect('2', 'act', { action: 'click', ref: 'e1' });
  assert.equal(clickRes.ok, true);
  assert.equal(elButton.clicked, 1);

  const fillRes = await sendInspect('3', 'act', { action: 'fill', ref: 'e2', value: 'Alice' });
  assert.equal(fillRes.ok, true);
  assert.equal(elInput.value, 'Alice');

  const snap = await sendInspect('4', 'snapshot', {});
  assert.equal(snap.ok, true);
  assert.equal(snap.data.title, 'Bridge Test');
  assert.equal(snap.data.metrics, undefined);
  assert.equal(snap.data.viewport.width, 1024);
  assert.equal(snap.data.text, 'Hello Preview');
});
