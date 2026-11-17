import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

/* Regression tests for the dev-server groundwork, booted through the real init path:
 *   - require('esbuild') is served by the embedded esbuild WASM build (no native binary);
 *   - require of Rollup's native loader is served by the vendored Rollup WASM build;
 *   - localhost resolves locally, as /etc/hosts does, so dev servers start offline;
 *   - fs.realpathSync.native exists (Vite uses it for every resolution). */

const rt = await initToolchain(loadRuntime());

test('init mounts the esbuild shim and the Rollup WASM files under /.beownir/runtime', () => {
  const mounted = rt.evaluate(`(() => { const fs = CORE.module.createRequire('/project/index.js')('fs'); return ['/.beownir/runtime/esbuild.js', '/.beownir/runtime/esbuild.wasm', '/.beownir/runtime/esbuild-shim.js', '/.beownir/runtime/rollup/native.js', '/.beownir/runtime/rollup/wasm-node/bindings_wasm.js', '/.beownir/runtime/rollup/wasm-node/bindings_wasm_bg.wasm'].map(p => fs.existsSync(p) ? 'yes' : 'no').join(','); })()`);
  assert.equal(mounted, 'yes,yes,yes,yes,yes,yes');
});

test('require("esbuild") resolves to the WASM-backed shim and transforms TypeScript', async () => {
  const result = JSON.parse(await rt.evaluate(`(async () => {
    const require = CORE.module.createRequire('/project/index.js');
    const esbuild = require('esbuild');
    const out = await esbuild.transform('const n: number = 1', { loader: 'ts' });
    let sync = 'no-throw';
    try { esbuild.transformSync('const x = 1'); } catch (error) { sync = error.message; }
    return JSON.stringify({
      code: out.code.trim(),
      version: typeof esbuild.version,
      sync,
      cached: require('esbuild') === esbuild,
      resolvedTo: require.resolve('esbuild')
    });
  })()`));
  assert.equal(result.code, 'const n = 1;');
  assert.equal(result.version, 'string');
  assert.match(result.sync, /needs the native binary/);
  assert.equal(result.cached, true);
  assert.equal(result.resolvedTo, '/.beownir/runtime/esbuild-shim.js');
});

test('Rollup native.js is served by the WASM build, whatever binary the project installed', async () => {
  const outcome = JSON.parse(await rt.evaluate(`(async () => {
    const require = CORE.module.createRequire('/project/index.js');
    const fs = require('fs');
    fs.mkdirSync('/project/node_modules/rollup/dist', { recursive: true });
    fs.writeFileSync('/project/node_modules/rollup/dist/native.js', 'throw new Error("native binary")');
    const native = require('/project/node_modules/rollup/dist/native.js');
    const ast = native.parse('const a = 1;', false, false);
    return JSON.stringify({ exports: Object.keys(native).sort().join(','), bytes: ast.byteLength || ast.length });
  })()`));
  assert.match(outcome.exports, /parse/);
  assert.match(outcome.exports, /parseAsync/);
  assert.ok(outcome.bytes > 0, 'the WASM parser must return an AST buffer');
});

test('localhost resolves to loopback without a DNS-over-HTTPS round trip', async () => {
  const addresses = JSON.parse(await rt.evaluate(`(async () => {
    const dns = CORE.module.createRequire('/project/index.js')('dns');
    return JSON.stringify({ v4: await dns.promises.resolve4('localhost'), v6: await dns.promises.resolve6('localhost') });
  })()`));
  assert.deepEqual(addresses.v4, ['127.0.0.1']);
  assert.deepEqual(addresses.v6, ['::1']);
});

test('fs.realpathSync.native is available for resolvers that call it', () => {
  const resolved = rt.evaluate(`CORE.module.createRequire('/project/index.js')('fs').realpathSync.native('/project')`);
  assert.equal(resolved, '/project');
});

test('process.stdout after init (the kernel stdio stream) keeps the TTY window-size surface', () => {
  const info = JSON.parse(rt.evaluate(`JSON.stringify({
    size: process.stdout.getWindowSize(),
    colors: process.stdout.hasColors(),
    rows: process.stdout.rows,
    stderr: typeof process.stderr.getWindowSize
  })`));
  assert.deepEqual(info, { size: [80, 24], colors: true, rows: 24, stderr: 'function' });
});

test('@tailwindcss/oxide resolves to the JavaScript scanner and finds candidates in project sources', () => {
  const result = JSON.parse(rt.evaluate(`(() => {
    const require = CORE.module.createRequire('/project/index.js');
    const fs = require('fs');
    fs.mkdirSync('/project/tw/src/nested', { recursive: true });
    fs.mkdirSync('/project/tw/node_modules/junk', { recursive: true });
    fs.writeFileSync('/project/tw/index.html', '<div class="flex bg-red-500">hi</div>');
    fs.writeFileSync('/project/tw/src/nested/app.tsx', 'export const C = () => <p className="p-4 text-center" />;');
    fs.writeFileSync('/project/tw/node_modules/junk/skip.js', 'class="ignored-by-scanner"');
    const { Scanner } = require('@tailwindcss/oxide');
    const scanner = new Scanner({ sources: [{ base: '/project/tw', pattern: '*', negated: false }] });
    const candidates = scanner.scan();
    return JSON.stringify({
      resolvedTo: require.resolve('@tailwindcss/oxide'),
      found: ['flex', 'bg-red-500', 'p-4', 'text-center'].map(c => candidates.includes(c)),
      skipped: candidates.includes('ignored-by-scanner'),
      files: scanner.files.length
    });
  })()`));
  assert.equal(result.resolvedTo, '/.beownir/runtime/compat/oxide.cjs');
  assert.deepEqual(result.found, [true, true, true, true]);
  assert.equal(result.skipped, false, 'node_modules must not be scanned');
  assert.equal(result.files, 2);
});

test('lightningcss resolves to the pass-through stand-in that exposes the API Tailwind calls', () => {
  const result = JSON.parse(rt.evaluate(`(() => {
    const require = CORE.module.createRequire('/project/index.js');
    const lc = require('lightningcss');
    const out = lc.transform({ code: Buffer.from('a{color:red}') });
    return JSON.stringify({ resolvedTo: require.resolve('lightningcss'), features: typeof lc.Features.Nesting, text: Buffer.from(out.code).toString() });
  })()`));
  assert.equal(result.resolvedTo, '/.beownir/runtime/compat/lightningcss.cjs');
  assert.equal(result.features, 'number');
  assert.equal(result.text, 'a{color:red}');
});

test('an Upgrade request reaches the server as an upgrade event and both sides can exchange frames', async () => {
  const outcome = JSON.parse(await rt.evaluate(`(async () => {
    const http = CORE.module.createRequire('/project/index.js')('http');
    const server = http.createServer(() => {});
    server.on('upgrade', (request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: test\\r\\n\\r\\n');
      socket.on('data', chunk => socket.write('echo:' + chunk));
    });
    await new Promise(resolve => server.listen(3231, '127.0.0.1', resolve));
    const reply = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: 3231, path: '/hmr', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGVzdA==', 'Sec-WebSocket-Version': '13' } });
      request.on('upgrade', (response, socket, head) => {
        socket.on('data', chunk => { resolve(JSON.stringify({ status: response.statusCode, upgrade: response.headers.upgrade, reply: String(chunk), head: head.length })); socket.destroy(); });
        socket.write('ping');
      });
      request.on('error', reject);
      request.end();
      setTimeout(() => reject(new Error('no upgrade within 5s')), 5000);
    });
    server.close();
    return reply;
  })()`));
  assert.equal(outcome.status, 101);
  assert.equal(outcome.upgrade, 'websocket');
  assert.equal(outcome.reply, 'echo:ping');
});
