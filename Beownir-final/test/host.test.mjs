import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostFile = path.join(root, 'o', 'host', 'beownir-host.mjs');
const appFile = path.join(root, 'o', 'site', 'index.html');

function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findBase() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    if (await portFree(base) && await portFree(base + 1) && await portFree(base + 2)) return base;
  }
  throw new Error('no free three-port block');
}

function startHost(args, env) {
  const child = spawn(process.execPath, [hostFile, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host did not start in 30s\n' + stdout + '\n' + stderr)), 30000);
    const poll = setInterval(() => {
      if ((stdout.match(/ on 0\.0\.0\.0:\d+/g) || []).length >= 3) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
      if (child.exitCode !== null) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error('host exited early with ' + child.exitCode + '\n' + stdout + '\n' + stderr));
      }
    }, 25);
  });
  ready.catch(() => { /* surfaced by whoever awaits it */ });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited, output: () => stdout + stderr };
}

const get = (url, init = {}) => fetch(url, { redirect: 'manual', headers: { 'accept-encoding': 'identity', ...(init.headers || {}) }, ...init });

test('the host serves the IDE, runtime assets and preview from three isolated origins', { timeout: 120000 }, async () => {
  const base = await findBase();
  const host = startHost([appFile], { PORT: String(base) });
  try {
    await host.ready;
    const ide = 'http://127.0.0.1:' + base;
    const runtime = 'http://127.0.0.1:' + (base + 1);
    const preview = 'http://127.0.0.1:' + (base + 2);

    /* --- IDE origin --- */
    const page = await get(ide + '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.match(page.headers.get('x-beownir-version') || '', /^\d+\.\d+\.\d+/);
    assert.match(page.headers.get('permissions-policy') || '', /cross-origin-isolated=\(self "http:\/\/127\.0\.0\.1:\d+" "http:\/\/127\.0\.0\.1:\d+"\)/);
    const etag = page.headers.get('etag');
    assert.ok(etag, 'IDE page has an ETag');
    const body = await page.text();
    assert.ok(body.length > 8 * 1024 * 1024, 'the whole single-file app is served: ' + body.length);
    assert.ok(body.includes('window.__BEOWNIR_HOST__='), 'host config is injected');
    assert.ok(body.includes('"ideOrigin":"http://127.0.0.1:' + base + '"'));

    const cached = await get(ide + '/', { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304);
    assert.equal((await cached.text()).length, 0);

    const head = await get(ide + '/index.html', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()).length, 0);

    const health = await get(ide + '/healthz');
    assert.equal(health.status, 200);
    const info = await health.json();
    assert.equal(info.role, 'ide');
    assert.equal(info.ok, true);
    assert.ok(info.assets >= 10, 'assets are loaded: ' + info.assets);

    const worker = await get(ide + '/coi-sw.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type') || '', /javascript/);
    assert.equal(worker.headers.get('service-worker-allowed'), '/');
    assert.match(await worker.text(), /Cross-Origin-Embedder-Policy/);

    assert.equal((await get(ide + '/nope')).status, 404);
    assert.equal((await get(ide + '/', { method: 'POST' })).status, 405);

    /* --- runtime origin --- */
    const frame = await get(runtime + '/');
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /__BEOWNIR_FRAME_CONFIG__/);

    const asset = await get(runtime + '/native-kernel.mjs');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.match(asset.headers.get('content-type') || '', /javascript/);
    assert.ok((await asset.text()).length > 1000);
    const assetEtag = asset.headers.get('etag');
    assert.ok(assetEtag);
    assert.equal((await get(runtime + '/native-kernel.mjs', { headers: { 'if-none-match': assetEtag } })).status, 304);
    assert.equal((await get(runtime + '/missing-asset.mjs')).status, 404);

    const blockedDns = await get(runtime + '/dns-query?name=evil.example&type=A');
    assert.equal(blockedDns.status, 403);
    const allowedDns = await get(runtime + '/dns-query?name=registry.npmjs.org&type=A');
    assert.equal(allowedDns.status, 200);
    assert.match(allowedDns.headers.get('content-type') || '', /application\/dns-json/);
    const dnsBody = await allowedDns.json();
    assert.equal(typeof dnsBody.Status, 'number');
    assert.ok(Array.isArray(dnsBody.Answer));

    const runtimeHealth = await (await get(runtime + '/healthz')).json();
    assert.equal(runtimeHealth.role, 'runtime');

    /* --- preview origin --- */
    const previewHealth = await (await get(preview + '/healthz')).json();
    assert.equal(previewHealth.role, 'preview');
    const offline = await get(preview + '/');
    assert.equal(offline.status, 503);
    assert.match(await offline.text(), /not connected/);
    assert.equal((await get(preview + '/_session/' + 'a'.repeat(32))).status, 404);

    /* --- shutdown --- */
    const started = Date.now();
    host.child.kill('SIGTERM');
    const exit = await host.exited;
    assert.equal(exit.code, 0, 'clean shutdown, output:\n' + host.output());
    assert.ok(Date.now() - started < 5000, 'shutdown is prompt');
  } finally {
    if (host.child.exitCode === null) host.child.kill('SIGKILL');
  }
});

test('the host fails fast with a clear message for a bad PORT or a missing HTML file', { timeout: 30000 }, async () => {
  const badPort = startHost([appFile], { PORT: '80' });
  const first = await badPort.exited;
  assert.notEqual(first.code, 0);
  assert.match(badPort.output(), /PORT must be 1024/);

  const missing = startHost(['/tmp/definitely-not-here-' + process.pid + '.html'], { PORT: '4173' });
  const second = await missing.exited;
  assert.equal(second.code, 2);
  assert.match(missing.output(), /cannot find the single-file app/i);
});

test('websocket upgrades without a trusted origin are rejected', { timeout: 60000 }, async () => {
  if (typeof WebSocket !== 'function') return;
  const base = await findBase();
  const host = startHost([appFile], { PORT: String(base) });
  const attempt = url => new Promise(resolve => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { try { socket.close(); } catch {} resolve('timeout'); }, 8000);
    socket.addEventListener('open', () => { clearTimeout(timer); try { socket.close(); } catch {} resolve('open'); });
    socket.addEventListener('error', () => { clearTimeout(timer); resolve('rejected'); });
    socket.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); });
  });
  try {
    await host.ready;
    const runtime = 'ws://127.0.0.1:' + (base + 1);
    const id = 'a'.repeat(32), cap = 'b'.repeat(64);
    assert.notEqual(await attempt(runtime + '/tcp/'), 'open', 'the registry relay requires a same-origin browser page');
    assert.notEqual(await attempt(runtime + '/owner/' + id + '?cap=' + cap), 'open', 'the preview broker requires a runtime origin');
    assert.notEqual(await attempt('ws://127.0.0.1:' + (base + 2) + '/socket'), 'open', 'the preview origin requires a session cookie');
  } finally {
    host.child.kill('SIGTERM');
    await host.exited;
  }
});
