import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConfig, createServer, headersFor, root } from '../tools/serve-static.mjs';
import { checkHeaders } from '../tools/deploy-files.mjs';

/* Deployment is a product surface: the whole point of the single file is that a
 * static host serves it. `netlify.toml` at the repository root is what makes
 * "connect the repo to Netlify" work with no dashboard settings — Netlify does
 * not read `o/netlify.toml` unless the site's base directory is `o`. These tests
 * keep the two configs honest and prove the page is served with the isolation
 * headers the runtime needs. */

const site = path.join(root, 'o', 'site');
const rootToml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
const nestedToml = fs.readFileSync(path.join(site, '..', 'netlify.toml'), 'utf8');
const config = parseConfig(rootToml);
const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');

const ISOLATION = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Origin-Agent-Cluster', 'Permissions-Policy'];

test('the repository root deploys o/site with no build step', () => {
  assert.equal(config.publish, 'o/site', 'publish directory is relative to the repository root');
  // The build command exists only to verify; it must never write to the site, or
  // "the file is the artifact" would stop being true.
  const command = /\[build\][\s\S]*?command\s*=\s*"([^"]+)"/.exec(rootToml)?.[1] || '';
  assert.match(command, /build-standalone\.mjs --check/, 'the deploy build checks the artifact');
  assert.ok(!/--write|--out|>\s*o\/site/.test(command), 'the deploy build does not rewrite the site');
  assert.match(rootToml, /NODE_VERSION = "22"/, 'the deploy pins Node 22');
  const published = path.join(root, config.publish);
  const files = fs.readdirSync(published).sort();
  assert.deepEqual(files, ['_headers', 'coi-sw.js', 'index.html'], 'the deploy is the single file, the isolation worker and the header file');
  assert.deepEqual(checkHeaders(), [], 'o/site/_headers is generated from netlify.toml and current');
  assert.ok(fs.statSync(path.join(published, 'index.html')).size > 6_000_000, 'the published HTML carries the runtime');
});

test('the root config and the base=o config cannot drift apart', () => {
  const nested = parseConfig(nestedToml);
  assert.equal(nested.publish, 'site', 'the nested config publishes its own directory');
  const rootHeaders = headersFor(config, '/');
  const nestedHeaders = headersFor(nested, '/');
  for (const name of ISOLATION) {
    assert.equal(rootHeaders[name], nestedHeaders[name], name + ' is identical in both configs');
  }
  const permissions = String(rootHeaders['Permissions-Policy']);
  assert.match(permissions, /cross-origin-isolated=(\*|\([^)]*\))/, 'the isolation feature is delegated');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
    assert.ok(permissions.includes(feature + '=()'), feature + ' stays disabled');
  }
});

test('every response carries the headers that enable cross-origin isolation', () => {
  const headers = headersFor(config, '/');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(headers['Origin-Agent-Cluster'], '?1');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(headersFor(config, '/nested/deep/file.js')['Cross-Origin-Embedder-Policy'] === 'require-corp', 'the wildcard covers deep paths');
});

test('the shell and the worker are never cached as immutable', () => {
  for (const pathname of ['/', '/index.html', '/coi-sw.js']) {
    const cache = headersFor(config, pathname)['Cache-Control'] || '';
    assert.match(cache, /max-age=0|no-cache|no-store/, pathname + ' must revalidate: ' + cache);
  }
  assert.equal(headersFor(config, '/coi-sw.js')['Service-Worker-Allowed'], '/', 'the worker may control the whole origin');
});

test('the page is genuinely self-contained', () => {
  const external = [...page.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="(?:https?:)?\/\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(external, [], 'no asset is fetched from another origin');
  // Every <script src> in the file belongs to an embedded fixture or a preview
  // document, never to the page itself: the publish directory holds no scripts.
  assert.deepEqual(fs.readdirSync(site).filter(name => name.endsWith('.js')), ['coi-sw.js']);
  assert.ok(!/url\(\s*['"]?https?:/.test(page), 'no stylesheet references a remote URL');
  assert.ok(!page.includes('beownir-native-assets'), 'no WASIX asset pack is embedded');
  assert.ok(!page.includes('beownirHostSource'), 'no Node host script is embedded');
  assert.ok(!page.includes('-ORIGIN-HERE'), 'no placeholder origins were left behind');
});

test('the content security policy permits the in-page runtime frame', () => {
  const policy = page.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] || '';
  const directive = name => policy.split(';').map(part => part.trim()).find(part => part.startsWith(name + ' ')) || '';
  assert.ok(policy.includes("default-src 'none'"), 'the default is deny');
  assert.match(directive('frame-src'), /about:/, 'the srcdoc runtime frame is allowed');
  assert.match(directive('frame-src'), /blob:/, 'blob previews are allowed');
  assert.match(directive('worker-src'), /blob:/, 'the runtime worker is allowed');
  assert.match(directive('connect-src'), /registry\.npmjs\.org/, 'the installer may reach the registry');
  assert.match(directive('script-src'), /'unsafe-eval'/, 'the runtime compiles code it is given');
});

test('Serve-static reproduces the deploy: files, headers and safety', async t => {
  const server = createServer({ site, config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(response.headers.get('cache-control'), /max-age=0/);
  const html = await response.text();
  assert.equal(html.length, page.length, 'the served page is the checked-in artifact');

  const worker = await fetch(base + '/coi-sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');

  const head = await fetch(base + '/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const missing = await fetch(base + '/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cross-origin-embedder-policy'), 'require-corp', 'even 404s stay isolated');

  // A static server must not be a file server for the rest of the repository.
  for (const attack of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/o/site/../../package.json']) {
    const escaped = await fetch(base + attack);
    assert.equal(escaped.status, 404, attack + ' must not escape the publish directory');
  }
});
