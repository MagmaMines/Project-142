import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('package.json declares zero runtime dependencies and exports embed & bundler adapters', () => {
  assert.equal(pkg.dependencies, undefined, 'no runtime npm dependencies are declared');
  for (const key of ['.', './kernel', './vite', './next', './server']) {
    assert.ok(pkg.exports[key], 'package.json exports ' + key);
  }
  const viteMod = fs.readFileSync(path.join(root, 'o', 'embed', 'vite.mjs'), 'utf8');
  const nextMod = fs.readFileSync(path.join(root, 'o', 'embed', 'next.mjs'), 'utf8');
  const serverMod = fs.readFileSync(path.join(root, 'o', 'embed', 'server.mjs'), 'utf8');
  const sharedMod = fs.readFileSync(path.join(root, 'o', 'embed', 'shared.mjs'), 'utf8');
  for (const code of [viteMod, nextMod, serverMod, sharedMod]) {
    assert.ok(!/cdn\.|jsdelivr|unpkg|esm\.sh/i.test(code), 'no external CDN URLs exist in embed adapters');
  }
});

test('Vite plugin applies COOP/COEP headers, respects exclude, and serves local kernel + coi-sw.js', async t => {
  const { beownir } = await import('beownir/vite');
  const plugin = beownir({ exclude: /^\/api\// });
  assert.equal(plugin.name, 'beownir:cross-origin-isolation');

  const middlewares = [];
  plugin.configureServer({ middlewares: { use: fn => middlewares.push(fn) } });
  plugin.configurePreviewServer({ middlewares: { use: fn => middlewares.push(fn) } });
  assert.equal(middlewares.length, 2);

  const server = http.createServer((req, res) => {
    let idx = 0;
    const run = () => middlewares[0](req, res, () => {
      if (req.url === '/api/ping') { res.end('api-ok'); return; }
      res.end('app-ok');
    });
    if (idx++ === 0) run();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  const appRes = await fetch(base + '/index.html');
  assert.equal(appRes.status, 200);
  assert.equal(appRes.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(appRes.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(appRes.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await appRes.text(), 'app-ok');

  const excludedRes = await fetch(base + '/api/ping');
  assert.equal(excludedRes.headers.get('cross-origin-opener-policy'), null);
  assert.equal(await excludedRes.text(), 'api-ok');

  const kernelRes = await fetch(base + '/__beownir__/beownir-kernel.js');
  assert.equal(kernelRes.status, 200);
  assert.match(kernelRes.headers.get('content-type'), /javascript/);
  assert.equal(kernelRes.headers.get('x-content-type-options'), 'nosniff');
  const kernelBytes = Buffer.from(await kernelRes.arrayBuffer());
  assert.ok(kernelBytes.equals(fs.readFileSync(path.join(root, 'o', 'embed', 'beownir-kernel.js'))));

  const swRes = await fetch(base + '/coi-sw.js');
  assert.equal(swRes.status, 200);
  assert.equal(swRes.headers.get('service-worker-allowed'), '/');
  assert.match(swRes.headers.get('cache-control'), /no-cache/);
  const swBytes = Buffer.from(await swRes.arrayBuffer());
  assert.ok(swBytes.equals(fs.readFileSync(path.join(root, 'o', 'site', 'coi-sw.js'))));
});

test('Next.js wrapper preserves user headers and injects COOP/COEP + SW scope rules', async () => {
  const { withBeownir, getBeownirHeaders } = await import('beownir/next');
  const staticRules = getBeownirHeaders({ coep: 'credentialless' });
  assert.equal(staticRules[0].source, '/(.*)');
  assert.ok(staticRules[0].headers.some(h => h.key === 'Cross-Origin-Embedder-Policy' && h.value === 'credentialless'));
  assert.equal(staticRules[1].source, '/coi-sw.js');
  assert.ok(staticRules[1].headers.some(h => h.key === 'Service-Worker-Allowed' && h.value === '/'));

  const wrapped = withBeownir({
    reactStrictMode: true,
    async headers() {
      return [{ source: '/health', headers: [{ key: 'X-Health', value: '1' }] }];
    },
  });
  assert.equal(wrapped.reactStrictMode, true);
  const allRules = await wrapped.headers();
  assert.equal(allRules[0].source, '/health');
  assert.equal(allRules[1].source, '/(.*)');
  assert.equal(allRules[2].source, '/coi-sw.js');
});

test('Server middleware and Fetch web-asset handler serve assets and apply isolation headers', async t => {
  const { createBeownirMiddleware, createWebAssetResponse, applyIsolationHeaders } = await import('beownir/server');
  const mw = createBeownirMiddleware({ basePath: '/assets' });
  const server = http.createServer((req, res) => {
    mw(req, res, () => {
      if (req.url === '/manual') applyIsolationHeaders(res, { corp: 'cross-origin' });
      res.end('ok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  const kernelHead = await fetch(base + '/assets/beownir-kernel.js', { method: 'HEAD' });
  assert.equal(kernelHead.status, 200);
  assert.equal(await kernelHead.text(), '');
  assert.equal(kernelHead.headers.get('cross-origin-embedder-policy'), 'require-corp');

  const manualRes = await fetch(base + '/manual');
  assert.equal(manualRes.headers.get('cross-origin-resource-policy'), 'cross-origin');

  const webKernel = createWebAssetResponse(new Request('https://example.test/__beownir__/beownir-kernel.js'));
  assert.ok(webKernel instanceof Response);
  assert.equal(webKernel.status, 200);
  assert.equal(webKernel.headers.get('cross-origin-opener-policy'), 'same-origin');

  const webMiss = createWebAssetResponse(new Request('https://example.test/not-beownir'));
  assert.equal(webMiss, null);
});
