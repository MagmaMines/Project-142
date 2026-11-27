/* Embed acceptance: a plain third-party page (test/embed/index.html — its own
 * HTML/CSS, one <script src="./beownir-kernel.js">) must boot the kernel, run
 * node, npm-install a real package, serve HTTP on a virtual port, sync files
 * back and tear down. This serves that page plus the built bundle from a bare
 * static directory — no other Beownir machinery — and drives it headless.
 *
 *   BEOWNIR_PLAYWRIGHT=/path/to/playwright-core  (or: npm i -D playwright-core)
 *   BEOWNIR_CHROMIUM=/path/to/chrome
 *   node test/embed/embed-e2e.cjs
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const bundle = path.join(root, 'o', 'embed', 'beownir-kernel.js');
const page = path.join(__dirname, 'index.html');

const PORT = Number(process.env.EMBED_E2E_PORT || 8124);
const TIMEOUT_MS = 300000;

function serve(dir, port) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const file = path.join(dir, request.url === '/' ? 'index.html' : request.url.split('?')[0]);
      fs.readFile(file, (error, data) => {
        if (error) { response.writeHead(404); response.end('not found'); return; }
        response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
        response.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  if (!fs.existsSync(bundle)) { console.error('missing o/embed/beownir-kernel.js — run node tools/build-embed.mjs'); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-embed-'));
  fs.copyFileSync(bundle, path.join(dir, 'beownir-kernel.js'));
  fs.copyFileSync(page, path.join(dir, 'index.html'));

  const server = await serve(dir, PORT);
  const origin = 'http://127.0.0.1:' + PORT;
  console.log('[embed-e2e] serving', origin, 'from', dir);

  const { chromium } = require(process.env.BEOWNIR_PLAYWRIGHT || 'playwright-core');
  const browser = await chromium.launch({
    executablePath: process.env.BEOWNIR_CHROMIUM || undefined,
    args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader'],
  });
  const context = await browser.newContext({ bypassCSP: false });
  const pageHandle = await context.newPage();
  pageHandle.on('pageerror', error => console.error('[embed-e2e] pageerror:', String(error).slice(0, 400)));
  pageHandle.on('console', message => { if (message.type() === 'error') console.error('[embed-e2e] console.error:', message.text().slice(0, 300)); });

  await pageHandle.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pageHandle.waitForFunction(() => window.__embedDone === true, null, { timeout: TIMEOUT_MS });
  const results = await pageHandle.evaluate(() => window.__embedResult);

  let failed = false;
  for (const result of results) {
    console.log((result.ok ? 'PASS' : 'FAIL') + '  ' + result.name + (result.detail ? ' — ' + result.detail : '') + '  (' + result.ms + ' ms)');
    if (!result.ok) failed = true;
  }
  await browser.close();
  server.close();
  if (failed) { console.error('[embed-e2e] FAIL'); process.exit(1); }
  console.log('[embed-e2e] PASS: ' + results.length + '/' + results.length + ' checks on a plain third-party page');
})().catch(error => { console.error('[embed-e2e] FAIL:', error); process.exit(1); });
