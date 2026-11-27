/**
 * The headless embed bundle is a shipped surface: third-party web IDEs load
 * o/embed/beownir-kernel.js and nothing else from Beownir. These tests pin the
 * two ways it can silently rot:
 *
 *   1. drift — the payload inside the bundle must be byte-identical to the
 *      sources embedded in the application, so a host always gets the runtime
 *      that was verified, not an older copy;
 *   2. surface — the bundle must actually evaluate and export the documented
 *      API with the product's version.
 *
 * The browser end-to-end (boot, node, npm install, virtual dev server, sync,
 * teardown) lives in test/embed/embed-e2e.cjs, which needs a Chromium binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, payload, block, root, templatePath, outputPath } from '../tools/build-embed.mjs';

const appHtml = fs.readFileSync(path.join(root, 'o', 'site', 'index.html'), 'utf8');
const template = fs.readFileSync(templatePath, 'utf8');

test('the generator extracts every asset block from the application source', () => {
  for (const id of ['runtimeSource', 'runtimeFrameSource', 'pakoSource', 'esbuildWasm', 'esbuildBrowser']) {
    assert.ok(appHtml.includes('<script id="' + id + '"'), id + ' anchor is present');
  }
  assert.equal(payload().runtime, block(appHtml, 'runtimeSource'));
  assert.equal(payload().kernel, block(appHtml, 'runtimeFrameSource'));
});

test('the built bundle is generated from the application, not a copy', () => {
  const built = build();
  assert.ok(!built.includes('__BEOWNIR_EMBED_BUILD__'), 'the placeholder is replaced');
  assert.ok(built.includes(template.slice(0, built.length ? 120 : 0).slice(0, 60).trim() || '/*! Beownir headless kernel'), 'the template header opens the bundle');
  /* The JSON literal is escaped for every HTML context: no raw `</script`, no
   * raw <, > or & that could break a host page that inlines the bundle. */
  const literal = built.slice(built.indexOf('const BUILD = '), built.indexOf(';\n', built.indexOf('const BUILD = ')));
  assert.ok(!/[<>]/.test(literal.slice(0, 200)), 'the literal is escaped');
  const parsed = JSON.parse(literal.slice('const BUILD = '.length));
  assert.equal(parsed.runtime, payload().runtime, 'the worker runtime matches the IDE byte for byte');
  assert.equal(parsed.kernel, payload().kernel, 'the frame kernel matches the IDE byte for byte');
  assert.equal(parsed.pako, payload().pako, 'pako matches the IDE byte for byte');
});

test('the committed bundle is current', () => {
  assert.ok(fs.existsSync(outputPath), 'o/embed/beownir-kernel.js exists: run node tools/build-embed.mjs');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), build(), 'o/embed/beownir-kernel.js matches the sources: run node tools/build-embed.mjs');
});

test('the bundle parses as JavaScript', () => {
  execFileSync(process.execPath, ['--check', outputPath]);
});

test('the bundle evaluates and exports the documented API', () => {
  const source = fs.readFileSync(outputPath, 'utf8');
  const globalThisBackup = globalThis.BeownirKernel;
  try {
    const evaluate = new Function(source + '\n;return BeownirKernel;');
    const api = evaluate();
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(api.version, pkg.version);
    assert.equal(typeof api.create, 'function');
    assert.equal(typeof api.BeownirKernel, 'function');
    assert.equal(typeof api.normalisePath, 'function');
    assert.equal(typeof api.capabilities, 'function');
    assert.ok(Object.isFrozen(api), 'the API object is frozen');
    /* Two loads must not fight over the global (the IIFE is idempotent). */
    const second = new Function(source + '\n;return BeownirKernel;')();
    assert.equal(second, api);
  } finally {
    if (globalThisBackup === undefined) delete globalThis.BeownirKernel;
    else globalThis.BeownirKernel = globalThisBackup;
  }
});

test('normalisePath applies Node-style rules relative to /project', () => {
  const api = new Function(fs.readFileSync(outputPath, 'utf8') + '\n;return BeownirKernel;')();
  const normalisePath = api.normalisePath;
  assert.equal(normalisePath('app.js'), '/project/app.js');
  assert.equal(normalisePath('/project/app.js'), '/project/app.js');
  assert.equal(normalisePath('a/../b'), '/project/b');
  assert.equal(normalisePath('./a/./b'), '/project/a/b');
  assert.equal(normalisePath('\\tmp\\x'), '/tmp/x');
  assert.throws(() => normalisePath(''), TypeError);
  assert.throws(() => normalisePath('   '), TypeError);
  assert.throws(() => normalisePath(42), TypeError);
});

test('the template documents what the kernel cannot do', () => {
  /* The header is the contract: no raw TCP/UDP, no native addons, no real
   * ports. If this assertion fails, the docs and the code have drifted. */
  for (const claim of ['raw TCP/UDP', 'native addons (.node)', 'real ports']) {
    assert.ok(template.includes(claim), 'the header names the limit: ' + claim);
  }
});

test('writeFileBytes, setFiles, removeFile and destroy maintain kernel/mirror integrity', async () => {
  const vm = await import('node:vm');
  const source = fs.readFileSync(outputPath, 'utf8');
  const posted = [];
  const domTimers = new Map();
  let nextTimer = 1;
  const fakeDocument = {
    createElement() {
      return {
        setAttribute() {},
        addEventListener() {},
        remove() {},
        style: {},
        contentWindow: { postMessage() {} },
      };
    },
    body: { appendChild() {} },
    querySelector() { return null; },
  };
  const context = {
    document: fakeDocument,
    setTimeout(fn, ms) { const id = nextTimer++; domTimers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { domTimers.delete(id); },
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    Promise,
    Error,
    TypeError,
    Object,
    Set,
    Map,
    URL,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  };
  context.window = context;
  context.globalThis = context;
  const api = vm.runInNewContext(source + '\n;BeownirKernel;', context);
  const kernel = api.create({ autostart: false, files: { '/project/old.txt': 'old', '/project/dir/child.txt': 'c' } });
  kernel._channel = { postMessage(msg) { posted.push(msg); }, close() {} };
  kernel._state = 'ready';

  await kernel.writeFileBytes('bin.dat', new Uint8Array([0x00, 0x80, 0xff, 0xfe]));
  assert.equal(kernel.readFile('bin.dat'), '__BEOWNIR_WASM64__:AID//g==');

  await kernel.removeFile('dir');
  assert.equal(kernel.exists('dir'), false);
  assert.equal(kernel.exists('dir/child.txt'), false);
  const rmMsg = posted[posted.length - 1];
  assert.equal(rmMsg.files['/project/dir'], null);
  assert.equal(rmMsg.files['/project/dir/child.txt'], null);

  await kernel.setFiles({ '/project/fresh.txt': 'new' });
  assert.equal(kernel.exists('old.txt'), false);
  assert.equal(kernel.exists('bin.dat'), false);
  assert.equal(kernel.readFile('fresh.txt'), 'new');
  const setMsg = posted[posted.length - 1];
  assert.equal(setMsg.files['/project/old.txt'], null);
  assert.equal(setMsg.files['/project/bin.dat'], null);
  assert.equal(setMsg.files['/project/fresh.txt'].c, 'new');

  const k2 = api.create({ autostart: true });
  k2.whenReady().catch(() => {});
  assert.equal(domTimers.size, 1, 'start() arms the boot timeout immediately');
  k2.destroy();
  assert.equal(domTimers.size, 0, 'destroy() clears the boot timeout');
});

test('BeownirKernel supports VirtualCookieJar, wildcard previewOrigin resolution, and dynamic network CSP policy', async () => {
  const vm = await import('node:vm');
  const source = fs.readFileSync(outputPath, 'utf8');
  const posted = [];
  const frames = [];
  const context = {
    console,
    document: {
      createElement(tag) {
        const el = {
          tagName: tag.toUpperCase(),
          attrs: {},
          style: {},
          setAttribute(k, v) { this.attrs[k] = String(v); },
          addEventListener() {},
          remove() {},
        };
        frames.push(el);
        return el;
      },
      body: { appendChild() {} },
    },
    setTimeout,
    clearTimeout,
    Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Promise, Error, TypeError, Object, Set, Map, URL, Headers, Response,
    btoa: globalThis.btoa, atob: globalThis.atob,
  };
  context.window = context;
  context.globalThis = context;
  const api = vm.runInNewContext(source + '\n;BeownirKernel;', context);

  const kernel = api.create({
    autostart: true,
    previewOrigin: 'https://*.preview.example.com',
    previewSessionId: 'demo42',
    network: { allowedFetchDomains: ['api.github.com', '*.npmjs.org'], corsProxy: 'https://proxy.example.com/?url=' },
  });
  const runtimeFrame = frames.find(f => f.tagName === 'IFRAME');
  assert.ok(runtimeFrame);
  assert.match(runtimeFrame.srcdoc, /connect-src https:\/\/registry\.npmjs\.org https:\/\/api\.github\.com https:\/\/\*\.npmjs\.org https:\/\/proxy\.example\.com/);
  assert.equal(kernel.resolvePreviewUrl(5173, '/app'), 'https://p5173-demo42.preview.example.com/app');

  const tplKernel = api.create({ autostart: false, previewOrigin: 'https://p{port}-{id}.edge.dev', previewSessionId: 's1' });
  assert.equal(tplKernel.resolvePreviewUrl(3000, 'api/hi'), 'https://p3000-s1.edge.dev/api/hi');

  kernel._channel = { postMessage(msg) { posted.push(msg); }, close() {} };
  kernel._state = 'ready';
  kernel._ready.resolve(kernel);

  // Per-port VirtualCookieJar across http() calls
  const p1 = kernel.http('http://localhost:3000/set');
  await new Promise(r => setTimeout(r, 0));
  const msg1 = posted.pop();
  kernel._receive({ type: 'httpres', id: msg1.id, status: 200, headers: { 'set-cookie': ['session=xyz; Path=/; HttpOnly', 'theme=dark; Path=/'] }, body: new Uint8Array() });
  await p1;

  assert.equal(kernel.getPreviewCookies(3000), 'theme=dark');
  assert.equal(kernel.getPreviewCookies(3000, '/', { includeHttpOnly: true }), 'session=xyz; theme=dark');
  assert.equal(kernel.getPreviewCookies(4000, '/', { includeHttpOnly: true }), '');

  const p2 = kernel.http('http://localhost:3000/check');
  await new Promise(r => setTimeout(r, 0));
  const msg2 = posted.pop();
  assert.match(msg2.headers.cookie, /session=xyz/);
  assert.match(msg2.headers.cookie, /theme=dark/);
  kernel._receive({ type: 'httpres', id: msg2.id, status: 200, headers: {}, body: new Uint8Array() });
  await p2;

  kernel.setPreviewCookie(3000, 'injected=bad; HttpOnly');
  assert.ok(!kernel.getPreviewCookies(3000, '/', { includeHttpOnly: true }).includes('injected='));
  kernel.clearPreviewCookies(3000);
  assert.equal(kernel.getPreviewCookies(3000, '/', { includeHttpOnly: true }), '');

  kernel.setNetworkConfig({ allowedFetchDomains: ['registry.yarnpkg.com'], corsProxy: null, useHostProxy: true });
  const netMsg = posted.pop();
  assert.equal(netMsg.type, 'set-network');
  assert.deepEqual(JSON.parse(JSON.stringify(netMsg.network)), { allowedFetchDomains: ['registry.yarnpkg.com'], corsProxy: null, useHostProxy: true });

  // stop() and kernel-stopped cleanly tear down without auto-restarting
  let terminatedSent = false;
  const oldChannel = { postMessage(m) { if (m?.type === 'terminate') terminatedSent = true; }, close() {} };
  kernel._channel = oldChannel;
  kernel._frame = { remove() {} };
  const cmdPromise = kernel.run('node -e "setTimeout(()=>{}, 1000)"');
  kernel.stop();
  assert.equal(terminatedSent, true);
  assert.equal(kernel.state, 'stopped');
  assert.equal(kernel.ready, false);
  await assert.rejects(cmdPromise, /stopped/);

  // Relative corsProxy relays host-fetch even when useHostProxy flag is omitted
  const fetched = [];
  kernel._state = 'ready';
  kernel._channel = { postMessage(msg) { posted.push(msg); }, close() {} };
  kernel._network = { allowedFetchDomains: ['api.github.com'], corsProxy: '/__beownir_cors_proxy__', useHostProxy: false };
  context.fetch = async (url) => {
    fetched.push(String(url));
    return new Response('proxy-ok', { status: 200 });
  };
  kernel._receive({ type: 'host-fetch', id: 'hf-1', url: 'https://api.github.com/zen', method: 'GET' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(fetched[0], '/__beownir_cors_proxy__?url=https%3A%2F%2Fapi.github.com%2Fzen');

  kernel._receive({ type: 'kernel-stopped' });
  assert.equal(kernel.state, 'stopped');

  kernel.destroy();
  tplKernel.destroy();
});
