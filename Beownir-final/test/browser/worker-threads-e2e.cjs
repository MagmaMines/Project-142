/* Browser E2E acceptance for real multi-threaded worker_threads, SharedArrayBuffer,
 * Atomics, WASI shared memory, MessageChannel/BroadcastChannel/SHARE_ENV, and
 * plain-HTTP degraded fallback across both o/embed/beownir-kernel.js and o/site/index.html.
 *
 *   BEOWNIR_PLAYWRIGHT=/path/to/playwright-core  (or: npm i -D playwright-core)
 *   BEOWNIR_CHROMIUM=/path/to/chrome
 *   node test/browser/worker-threads-e2e.cjs
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const embedPath = path.join(root, 'o', 'embed', 'beownir-kernel.js');
const sitePath = path.join(root, 'o', 'site', 'index.html');
const TIMEOUT_MS = 120000;

const testPage = `<!doctype html><meta charset="utf-8"><script src="/beownir-kernel.js"></script><script>
window.__bootKernel = async () => {
  const k = BeownirKernel.create({ autostart: false });
  await k.start();
  await k.whenReady();
  window.__k = k;
  return { coi: window.crossOriginIsolated, sab: typeof SharedArrayBuffer };
};
</script>`;

function startServer(embedBundle, siteHtml, coi) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const headers = { 'cache-control': 'no-store' };
      if (coi) {
        headers['cross-origin-opener-policy'] = 'same-origin';
        headers['cross-origin-embedder-policy'] = 'require-corp';
        headers['cross-origin-resource-policy'] = 'same-origin';
        headers['permissions-policy'] = 'cross-origin-isolated=*';
      }
      if (req.url === '/beownir-kernel.js') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
        res.end(embedBundle);
      } else if (req.url.startsWith('/__beownir_cors_proxy__')) {
        const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url');
        res.writeHead(200, {
          ...headers,
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'cross-origin-resource-policy': 'cross-origin',
        });
        res.end(JSON.stringify({ proxied: true, target }));
      } else if (req.url === '/site.html') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        res.end(siteHtml);
      } else {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        res.end(testPage);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  if (!fs.existsSync(embedPath)) throw new Error('missing o/embed/beownir-kernel.js — run npm run embed:build');
  if (!fs.existsSync(sitePath)) throw new Error('missing o/site/index.html');
  const embedBundle = fs.readFileSync(embedPath);
  const siteHtml = fs.readFileSync(sitePath);

  const { chromium } = require(process.env.BEOWNIR_PLAYWRIGHT || 'playwright-core');
  const srvCoi = await startServer(embedBundle, siteHtml, true);
  const srvPlain = await startServer(embedBundle, siteHtml, false);
  const browser = await chromium.launch({
    executablePath: process.env.BEOWNIR_CHROMIUM || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-angle=swiftshader'],
  });

  try {
    // 1. Cross-Origin Isolated Embed bundle
    const ctxCoi = await browser.newContext({ bypassCSP: false });
    const p1 = await ctxCoi.newPage();
    p1.on('pageerror', err => console.error('[threads-e2e] coi pageerror:', err));
    await p1.goto(`http://127.0.0.1:${srvCoi.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const boot1 = await p1.evaluate(() => window.__bootKernel());
    if (!boot1.coi || boot1.sab !== 'function') throw new Error('COI did not activate: ' + JSON.stringify(boot1));
    console.log('PASS  COI embed boot', JSON.stringify(boot1));

    await p1.evaluate(async () => {
      await window.__k.setFiles({
        '/project/worker_ping.js': [
          "const { parentPort, workerData, threadId, isMainThread, resourceLimits } = require('worker_threads');",
          "const i32 = new Int32Array(workerData.sab);",
          "Atomics.store(i32, 1, 98765);",
          "Atomics.store(i32, 0, 1);",
          "Atomics.notify(i32, 0, 1);",
          "parentPort.postMessage({ isMainThread, threadId, hasLimits: typeof resourceLimits.stackSizeMb === 'number' });",
        ].join('\n'),
        '/project/test_suite.js': [
          "const assert = require('assert');",
          "const fs = require('fs');",
          "const { Worker, MessageChannel, receiveMessageOnPort, BroadcastChannel, getEnvironmentData, setEnvironmentData, postMessageToThread, SHARE_ENV, isMainThread, threadId } = require('worker_threads');",
          "const { WASI } = require('wasi');",
          "async function main() {",
          "  assert.strictEqual(isMainThread, true);",
          "  assert.strictEqual(threadId, 0);",
          "  assert.strictEqual(crossOriginIsolated, true);",
          "  assert.strictEqual(typeof SharedArrayBuffer, 'function');",
          "  const sabBuf = new SharedArrayBuffer(16);",
          "  new Uint8Array(sabBuf).set(Buffer.from('hello-sab'));",
          "  const b = Buffer.from(sabBuf, 0, 9);",
          "  assert.strictEqual(b.toString('utf8'), 'hello-sab');",
          "  const wasiMem = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });",
          "  new Uint8Array(wasiMem.buffer).set(Buffer.from('wasi_out.txt'), 25);",
          "  const wasi = new WASI({ version: 'preview1', preopens: { '/': '/project' }, memory: wasiMem });",
          "  fs.writeFileSync('/project/wasi_out.txt', 'WASI_SAB_OK');",
          "  const fdPtr = 256, statPtr = 512;",
          "  assert.strictEqual(wasi.wasiImport.path_open(3, 0, 25, 12, 0, 0n, 0n, 0, fdPtr), 0);",
          "  const wasiFd = new DataView(wasiMem.buffer).getUint32(fdPtr, true);",
          "  assert.strictEqual(wasi.wasiImport.fd_filestat_get(wasiFd, statPtr), 0);",
          "  assert.strictEqual(Number(new DataView(wasiMem.buffer).getBigUint64(statPtr + 32, true)), 11);",
          "  assert.strictEqual(wasi.wasiImport.clock_res_get(1, 780), 0);",
          "  assert.ok(new DataView(wasiMem.buffer).getBigUint64(780, true) > 0n);",
          "  assert.strictEqual(wasi.wasiImport.clock_time_get(1, 0n, 792), 0);",
          "  assert.ok(new DataView(wasiMem.buffer).getBigUint64(792, true) > 0n);",
          "  assert.strictEqual(wasi.wasiImport.fd_readdir(3, 800, 0, 0n, 820), 0);",
          "  assert.strictEqual(new DataView(wasiMem.buffer).getUint32(820, true), 0);",
          "  const pollView = new DataView(wasiMem.buffer);",
          "  new Uint8Array(wasiMem.buffer).fill(0, 600, 768);",
          "  pollView.setBigUint64(600, 77n, true); pollView.setUint8(608, 1); pollView.setInt32(616, wasiFd, true);",
          "  assert.strictEqual(wasi.wasiImport.poll_oneoff(600, 700, 1, 750), 0);",
          "  assert.strictEqual(pollView.getUint32(750, true), 1);",
          "  assert.strictEqual(pollView.getBigUint64(716, true), 11n);",
          "  wasi.wasiImport.fd_close(wasiFd);",
          "  const cp = require('child_process');",
          "  const exOut = cp.execSync('echo hello-exec-sync', { encoding: 'utf8' });",
          "  assert.strictEqual(exOut, 'hello-exec-sync\\n');",
          "  const exCat = cp.execSync('cat', { input: 'piped-sync-text', encoding: 'utf8' });",
          "  assert.strictEqual(exCat, 'piped-sync-text');",
          "  const spRes = cp.spawnSync('node', ['-e', \"require('fs').writeFileSync('/project/sync_child.txt', 'from-sync:' + require('fs').readFileSync(0, 'utf8')); console.log('SYNC_OUT'); console.error('SYNC_ERR');\"], { input: 'stdin-sync-ok', encoding: 'utf8' });",
          "  assert.strictEqual(spRes.status, 0);",
          "  assert.strictEqual(spRes.stdout, 'SYNC_OUT\\n');",
          "  assert.strictEqual(spRes.stderr, 'SYNC_ERR\\n');",
          "  assert.strictEqual(fs.readFileSync('/project/sync_child.txt', 'utf8'), 'from-sync:stdin-sync-ok');",
          "  const missSync = cp.spawnSync('definitely-missing-bin');",
          "  assert.strictEqual(missSync.status, null);",
          "  assert.strictEqual(missSync.error && missSync.error.code, 'ENOENT');",
          "  assert.throws(() => cp.execFileSync('sh', ['-c', 'echo boom >&2 && exit 7']), err => err.status === 7 && Buffer.isBuffer(err.stderr) && err.stderr.toString('utf8') === 'boom\\n');",
          "  const syncSab = new SharedArrayBuffer(64); const syncI32 = new Int32Array(syncSab);",
          "  const t0 = performance.now();",
          "  const wSync = new Worker('/project/worker_ping.js', { workerData: { sab: syncSab } });",
          "  const events = []; wSync.on('online', () => events.push('online'));",
          "  const msgP = new Promise(r => wSync.once('message', m => { events.push('message'); r(m); }));",
          "  const exitP = new Promise(r => wSync.once('exit', c => { events.push('exit:' + c); r(c); }));",
          "  assert.strictEqual(Atomics.wait(syncI32, 0, 0, 5000), 'ok');",
          "  const waitMs = performance.now() - t0;",
          "  assert.strictEqual(Atomics.load(syncI32, 1), 98765);",
          "  const msg = await msgP; const code = await exitP;",
          "  assert.strictEqual(code, 0); assert.strictEqual(msg.isMainThread, false); assert.ok(msg.threadId >= 1);",
          "  assert.deepStrictEqual(events, ['online', 'message', 'exit:0']);",
          "  const ch = new MessageChannel(); const portSab = new SharedArrayBuffer(16); const portI32 = new Int32Array(portSab);",
          "  const wPort = new Worker(\"const { workerData } = require('worker_threads'); const i32 = new Int32Array(workerData.sab); workerData.port.postMessage({ n: 42, txt: 'sync-ring' }); workerData.port.postMessage({ n: 43, txt: 'async-ring' }); Atomics.store(i32, 0, 1); Atomics.notify(i32, 0, 1);\", { eval: true, workerData: { sab: portSab, port: ch.port2 }, transferList: [ch.port2] });",
          "  assert.strictEqual(Atomics.wait(portI32, 0, 0, 5000), 'ok');",
          "  assert.deepStrictEqual(receiveMessageOnPort(ch.port1), { message: { n: 42, txt: 'sync-ring' } });",
          "  assert.deepStrictEqual(await new Promise(r => ch.port1.once('message', r)), { n: 43, txt: 'async-ring' });",
          "  ch.port1.close(); await new Promise(r => wPort.once('exit', r));",
          "  const wPing = new Worker(\"const { parentPort } = require('worker_threads'); parentPort.on('message', m => { if (m.stop) { parentPort.close(); return; } if (m.routes) { parentPort.postMessage({ isMap: m.routes instanceof Map, entries: [...m.routes], isSet: m.tags instanceof Set, back: m }); return; } parentPort.postMessage({ pong: m.ping }); });\", { eval: true });",
          "  wPing.postMessage({ ping: 99 });",
          "  const pong = await new Promise(r => wPing.once('message', r));",
          "  assert.deepStrictEqual(pong, { pong: 99 });",
          "  wPing.postMessage({ routes: new Map([['/kit', { prerender: true }]]), tags: new Set(['s1']) });",
          "  const structMsg = await new Promise(r => wPing.once('message', r));",
          "  assert.strictEqual(structMsg.isMap, true); assert.deepStrictEqual(structMsg.entries, [['/kit', { prerender: true }]]); assert.strictEqual(structMsg.isSet, true);",
          "  assert.strictEqual(structMsg.back.routes instanceof Map, true); assert.deepStrictEqual([...structMsg.back.routes], [['/kit', { prerender: true }]]);",
          "  wPing.postMessage({ stop: true });",
          "  assert.strictEqual(await new Promise(r => wPing.once('exit', r)), 0);",
          "  setEnvironmentData('cfg', { mode: 'parallel', v: 7 });",
          "  const bc = new BroadcastChannel('beownir-chan');",
          "  const bcGot = new Promise(r => { bc.onmessage = ev => r(ev.data); });",
          "  const directGot = new Promise(r => process.once('workerMessage', (val, tid) => r({ val, tid })));",
          "  const wRich = new Worker(\"const fs = require('fs'); const { parentPort, BroadcastChannel, getEnvironmentData, postMessageToThread, threadId, threadName } = require('worker_threads'); process.env.CHILD_MUTATED = 'from-thread'; fs.writeFileSync('/project/from_thread.txt', 'written-by-thread-' + threadId); console.log('THREAD_STDOUT_LINE'); console.error('THREAD_STDERR_LINE'); const cfg = getEnvironmentData('cfg'); const c = new BroadcastChannel('beownir-chan'); c.postMessage({ from: threadId, cfg }); c.close(); postMessageToThread(0, { direct: true, threadId }); parentPort.postMessage({ ok: true, threadName, envVal: process.env.CHILD_MUTATED });\", { eval: true, name: 'rich-worker', env: SHARE_ENV, stdout: true, stderr: true });",
          "  const richOut = []; const richErr = [];",
          "  wRich.stdout.on('data', d => richOut.push(d.toString()));",
          "  wRich.stderr.on('data', d => richErr.push(d.toString()));",
          "  const [richMsg, richBc, richDirect, richExit] = await Promise.all([new Promise(r => wRich.once('message', r)), bcGot, directGot, new Promise(r => wRich.once('exit', r))]);",
          "  bc.close();",
          "  assert.strictEqual(richExit, 0); assert.strictEqual(richMsg.ok, true); assert.strictEqual(richMsg.threadName, 'rich-worker');",
          "  assert.strictEqual(process.env.CHILD_MUTATED, 'from-thread');",
          "  assert.strictEqual(fs.readFileSync('/project/from_thread.txt', 'utf8'), 'written-by-thread-' + wRich.threadId);",
          "  assert.ok(richOut.join('').includes('THREAD_STDOUT_LINE'));",
          "  assert.ok(richErr.join('').includes('THREAD_STDERR_LINE'));",
          "  assert.deepStrictEqual(richBc.cfg, { mode: 'parallel', v: 7 });",
          "  assert.strictEqual(richDirect.val.direct, true);",
          "  const wReceiver = new Worker(\"const { parentPort } = require('worker_threads'); parentPort.on('message', () => {}); process.once('workerMessage', (v, from) => { parentPort.postMessage({ v, from }); parentPort.close(); }); parentPort.postMessage('ready');\", { eval: true });",
          "  assert.strictEqual(await new Promise(r => wReceiver.once('message', r)), 'ready');",
          "  const wSender = new Worker(\"const { postMessageToThread, workerData } = require('worker_threads'); postMessageToThread(workerData.target, { hop: 'peer' });\", { eval: true, workerData: { target: wReceiver.threadId } });",
          "  const relayed = await new Promise(r => wReceiver.once('message', r));",
          "  assert.strictEqual(relayed.v.hop, 'peer'); assert.strictEqual(relayed.from, wSender.threadId);",
          "  await Promise.all([new Promise(r => wReceiver.once('exit', r)), new Promise(r => wSender.once('exit', r))]);",
          "  const wExit7 = new Worker('process.exit(7)', { eval: true });",
          "  let exit7Errored = false; wExit7.on('error', () => { exit7Errored = true; });",
          "  assert.strictEqual(await new Promise(r => wExit7.once('exit', r)), 7);",
          "  assert.strictEqual(exit7Errored, false);",
          "  const wThrow = new Worker(\"setTimeout(() => { throw new TypeError('thread-type-boom'); }, 10);\", { eval: true });",
          "  const [thrownErr, throwExit] = await Promise.all([new Promise(r => wThrow.once('error', r)), new Promise(r => wThrow.once('exit', r))]);",
          "  assert.strictEqual(thrownErr.name, 'TypeError'); assert.ok(thrownErr.message.includes('thread-type-boom')); assert.strictEqual(throwExit, 1);",
          "  assert.throws(() => new Worker('1', { eval: true, workerData: () => {} }), err => err.code === 25 || err.name === 'DataCloneError');",
          "  const badSab = new SharedArrayBuffer(8);",
          "  assert.throws(() => new Worker('1', { eval: true, workerData: badSab, transferList: [badSab] }), err => err.code === 25 || err.name === 'DataCloneError');",
          "  const wMiss = new Worker(new URL('file:///project/does_not_exist.js'));",
          "  const missErr = await new Promise(r => wMiss.once('error', r));",
          "  assert.strictEqual(missErr.code, 'MODULE_NOT_FOUND');",
          "  const mod = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));",
          "  const wMod = new Worker(\"const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage(workerData.mod instanceof WebAssembly.Module);\", { eval: true, workerData: { mod } });",
          "  assert.strictEqual(await new Promise(r => wMod.once('message', r)), true);",
          "  await new Promise(r => wMod.once('exit', r));",
          "  fs.writeFileSync('/project/mod.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));",
          "  const fRes = await fetch('file:///project/mod.wasm');",
          "  assert.strictEqual(fRes.status, 200);",
          "  assert.strictEqual(fRes.headers.get('content-type'), 'application/wasm');",
          "  const wTerm = new Worker('setInterval(() => {}, 100)', { eval: true });",
          "  await new Promise(r => wTerm.once('online', r));",
          "  assert.strictEqual(await wTerm.terminate(), 1);",
          "  console.log('ALL_CHROMIUM_THREAD_TESTS_PASSED waitMs=' + waitMs.toFixed(1));",
          "}",
          "main().catch(e => { console.error(e && e.stack || e); process.exit(1); });",
        ].join('\n'),
      });
    });
    const r1 = await p1.evaluate(() => window.__k.run('node /project/test_suite.js'));
    if (r1.code !== 0 || !r1.stdout.includes('ALL_CHROMIUM_THREAD_TESTS_PASSED')) {
      throw new Error('COI embed worker_threads suite failed: ' + JSON.stringify(r1));
    }
    console.log('PASS  COI embed worker_threads suite', r1.stdout.trim());

    const netRes = await p1.evaluate(async () => {
      const k = BeownirKernel.create({
        previewOrigin: 'https://*.preview.example.com',
        previewSessionId: 'e2eb',
        network: {
          allowedFetchDomains: ['api.github.com'],
          corsProxy: '/__beownir_cors_proxy__?url={url}',
          useHostProxy: true,
        },
        files: {
          '/project/cookie_srv.js': "require('http').createServer((req, res) => { if (req.url === '/login') { res.writeHead(200, { 'Set-Cookie': ['sid=secret123; Path=/; HttpOnly', 'ui=dark; Path=/'] }); res.end('ok'); } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ cookie: req.headers.cookie || '' })); } }).listen(4500);",
          '/project/net_check.mjs': "import assert from 'node:assert'; let err=''; try { await fetch('https://unlisted.invalid/x'); } catch (e) { err = e.message; } assert.ok(/Network restricted/i.test(err), err); const p = await fetch('https://api.github.com/zen'); const j = await p.json(); assert.strictEqual(j.proxied, true); console.log('NET_PROXY_OK');",
        },
      });
      await k.whenReady();
      const resolvedUrl = k.resolvePreviewUrl(4500, '/home');
      const netRun = await k.run('node /project/net_check.mjs');
      k.run('node /project/cookie_srv.js');
      await k.waitForServer(4500, { path: '/check' });
      await k.http('http://localhost:4500/login');
      const checkJson = await k.httpJson('http://localhost:4500/check');
      const docCookies = k.getPreviewCookies(4500);
      const otherCookies = k.getPreviewCookies(4501, '/', { includeHttpOnly: true });
      k.destroy();
      return { resolvedUrl, netRun, serverCookie: checkJson.cookie, docCookies, otherCookies };
    });
    if (netRes.resolvedUrl !== 'https://p4500-e2eb.preview.example.com/home' ||
        netRes.netRun.code !== 0 || !netRes.netRun.stdout.includes('NET_PROXY_OK') ||
        !netRes.serverCookie.includes('sid=secret123') || netRes.docCookies !== 'ui=dark' || netRes.otherCookies !== '') {
      throw new Error('COI embed cookie/network/previewOrigin check failed: ' + JSON.stringify(netRes));
    }
    console.log('PASS  COI embed VirtualCookieJar + wildcard previewOrigin + network proxy');

    // 2. Cross-Origin Isolated Main IDE Site (o/site/index.html)
    const p2 = await ctxCoi.newPage();
    p2.on('pageerror', err => console.error('[threads-e2e] site pageerror:', err));
    await p2.goto(`http://127.0.0.1:${srvCoi.address().port}/site.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p2.waitForFunction(() => window.Beownir && window.Beownir.status && window.Beownir.status().ready === true, null, { timeout: TIMEOUT_MS });
    await p2.evaluate(async () => {
      await window.Beownir.write('sab_check.js', [
        "const { Worker } = require('worker_threads');",
        "const sab = new SharedArrayBuffer(8);",
        "const w = new Worker(\"const s = new Int32Array(require('worker_threads').workerData); Atomics.store(s, 0, 77); Atomics.notify(s, 0, 1);\", { eval: true, workerData: sab });",
        "console.log('SITE_RESULT=' + crossOriginIsolated + ':' + Atomics.wait(new Int32Array(sab), 0, 0, 5000) + ':' + Atomics.load(new Int32Array(sab), 0));",
        "w.once('exit', c => console.log('SITE_WORKER_EXIT=' + c));",
      ].join('\n'));
      await window.Beownir.run('node /project/sab_check.js');
    });
    const siteText = await p2.evaluate(() => window.Beownir.terminalText());
    if (!siteText.includes('SITE_RESULT=true:ok:77') || !siteText.includes('SITE_WORKER_EXIT=0')) {
      throw new Error('COI main site worker_threads check failed: ' + siteText.slice(-300));
    }
    console.log('PASS  COI main site worker_threads + Atomics');

    await p2.evaluate(async () => {
      await window.Beownir.newProject('script');
      await window.Beownir.write('cookie_app.js', [
        "const http = require('http');",
        "http.createServer((req, res) => {",
        "  res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['app=preview1; Path=/', 'httpsec=hidden; Path=/; HttpOnly'] });",
        "  res.end('<!doctype html><html><body><pre id=\"out\"></pre><script>document.cookie=\"client=yes; Path=/\"; document.getElementById(\"out\").textContent=document.cookie;</script></body></html>');",
        "}).listen(4600);",
      ].join('\n'));
      window.Beownir.run('node /project/cookie_app.js');
    });
    await p2.waitForFunction(() => window.Beownir.status().ports.includes(4600), null, { timeout: 30000 });
    await p2.waitForTimeout(1500);
    const previewFrame = p2.frames().find(f => f !== p2.mainFrame() && f.url().startsWith('about:srcdoc'));
    if (!previewFrame) throw new Error('srcdoc preview frame not found on main site');
    await previewFrame.waitForSelector('#out', { timeout: 15000 });
    const outCookieText = await previewFrame.locator('#out').textContent();
    const hostCookie = await p2.evaluate(() => document.cookie);
    if (!outCookieText.includes('app=preview1') || !outCookieText.includes('client=yes') || outCookieText.includes('httpsec') || hostCookie !== '') {
      throw new Error('srcdoc VirtualCookieJar isolation failed: ' + JSON.stringify({ outCookieText, hostCookie }));
    }
    console.log('PASS  COI main site srcdoc VirtualCookieJar cookie isolation');

    // 3. Plain HTTP Degraded Non-COI mode
    const ctxPlain = await browser.newContext({ bypassCSP: false });
    const p3 = await ctxPlain.newPage();
    p3.on('pageerror', err => console.error('[threads-e2e] plain pageerror:', err));
    await p3.goto(`http://127.0.0.1:${srvPlain.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const boot3 = await p3.evaluate(() => window.__bootKernel());
    if (boot3.coi !== false || boot3.sab !== 'undefined') throw new Error('Expected non-COI mode: ' + JSON.stringify(boot3));

    await p3.evaluate(async () => {
      await window.__k.setFiles({
        '/project/plain.js': [
          "const assert = require('assert');",
          "const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');",
          "async function main() {",
          "  assert.strictEqual(crossOriginIsolated, false);",
          "  assert.strictEqual(typeof SharedArrayBuffer, 'undefined');",
          "  const ch = new MessageChannel();",
          "  ch.port2.postMessage({ ok: 1 });",
          "  assert.deepStrictEqual(receiveMessageOnPort(ch.port1), { message: { ok: 1 } });",
          "  ch.port1.close();",
          "  const w = new Worker(\"require('worker_threads').parentPort.postMessage('from-plain-worker');\", { eval: true });",
          "  assert.strictEqual(await new Promise(r => w.once('message', r)), 'from-plain-worker');",
          "  assert.strictEqual(await new Promise(r => w.once('exit', r)), 0);",
          "  const wTerm = new Worker('setInterval(() => {}, 50);', { eval: true });",
          "  await new Promise(r => wTerm.once('online', r));",
          "  assert.strictEqual(await wTerm.terminate(), 1);",
          "  assert.throws(() => require('child_process').spawnSync('echo', ['no-sab']), err => err.code === 'ERR_NOT_SUPPORTED');",
          "  console.log('PLAIN_HTTP_DEGRADED_OK');",
          "}",
          "main().catch(e => { console.error(e && e.stack || e); process.exit(1); });",
        ].join('\n'),
      });
    });
    const r3 = await p3.evaluate(() => window.__k.run('node /project/plain.js'));
    if (r3.code !== 0 || !r3.stdout.includes('PLAIN_HTTP_DEGRADED_OK')) {
      throw new Error('Plain HTTP degraded suite failed: ' + JSON.stringify(r3));
    }
    console.log('PASS  Plain HTTP degraded worker_threads fallback');
  } finally {
    await browser.close();
    srvCoi.close();
    srvPlain.close();
  }
})().catch(error => {
  console.error('[threads-e2e] FAIL:', error);
  process.exit(1);
});
