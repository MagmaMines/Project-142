/* End-to-end browser acceptance for the single-file IDE:
 * boot runtime -> create Vite app -> npm install -> npx vite (dev server) ->
 * preview renders -> edit src/message.js -> HMR updates the DOM, no reload.
 *
 * Not part of `npm test`: it needs a Chromium binary and playwright-core, and
 * it downloads vite from the registry through the runtime.
 *
 *   BEOWNIR_PLAYWRIGHT=/path/to/playwright-core  (or: npm i -D playwright-core)
 *   BEOWNIR_CHROMIUM=/path/to/chrome
 *   node test/browser/vite-hmr-e2e.cjs [origin]
 *
 * origin defaults to http://127.0.0.1:8085. Point it at a static host that
 * does not serve coi-sw.js to exercise the sandboxed srcdoc fallback, and at
 * the normal host to exercise the service-worker preview.
 */
const { chromium } = require(process.env.BEOWNIR_PLAYWRIGHT || 'playwright-core');

const origin = process.argv[2] || 'http://127.0.0.1:8085';
const executablePath = process.env.BEOWNIR_CHROMIUM || undefined;

const files = {
  'package.json': JSON.stringify({
    name: 'beownir-vite-e2e', private: true, version: '1.0.0', type: 'module',
    scripts: { dev: 'vite --port 5173' }, dependencies: { vite: '6.4.6' },
  }, null, 2) + '\n',
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Vite HMR E2E</title></head><body><main><small>REAL VITE · BROWSER</small><img id="logo" src="/logo.svg" width="42" height="42" alt="logo"><h1 id="app">BOOTING</h1></main><script type="module" src="/src/main.js"></script></body></html>',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42"><rect width="42" height="42" fill="#0a5c3f"/></svg>',
  'src/style.css': 'h1#app { color: rgb(1, 2, 3); }\n',
  'src/message.js': 'export const message = "VITE_E2E_INITIAL";\n',
  'src/main.js': `import './style.css';
import { message } from './message.js';
const heading = document.querySelector('#app');
heading.textContent = message;
if (import.meta.hot) {
  import.meta.hot.accept('./message.js', next => { if (next) heading.textContent = next.message; });
}
`,
};

(async () => {
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader'],
  });
  const context = await browser.newContext({ bypassCSP: false });
  const page = await context.newPage();
  /* Disable the IDE's live-reload full refresh so the only update path left is
   * Vite's own HMR websocket through the preview bridge. */
  await page.addInitScript(() => { try { localStorage.setItem('beownir-live-reload', '0'); } catch {} });
  const log = (...a) => console.log('[e2e]', ...a);
  page.on('pageerror', error => log('pageerror:', String(error).slice(0, 300)));
  const consoleLines = [];
  page.on('console', message => { consoleLines.push(message.text()); });

  log('opening', origin);
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.Beownir && window.Beownir.status && window.Beownir.status().ready === true, null, { timeout: 90000 });
  log('runtime ready:', await page.evaluate(() => window.Beownir.status().engine));

  log('creating clean project');
  await page.evaluate(() => window.Beownir.newProject('script'));
  for (const [path, content] of Object.entries(files)) {
    await page.evaluate(([p, c]) => window.Beownir.write(p, c), [path, content]);
  }
  log('files written');

  log('npm install (vite 6.4.6) — this can take a minute');
  await page.evaluate(() => window.Beownir.run('npm install'));
  log('install finished');

  log('starting vite dev server');
  const runResult = page.evaluate(() => window.Beownir.run('npx vite --host 127.0.0.1 --port 5173 --strictPort').then(() => 'ok', error => 'rejected: ' + (error && error.message || error)));
  await page.waitForTimeout(15000);
  log('terminal after 15s:\n' + await page.evaluate(() => window.Beownir.terminalText()));
  log('vite run settled:', await Promise.race([runResult, page.waitForTimeout(30000).then(() => 'still-running')]));
  log('terminal after settle:\n' + await page.evaluate(() => window.Beownir.terminalText()));
  await page.waitForFunction(() => window.Beownir.status().ports.includes(5173), null, { timeout: 30000 });
  log('vite listening on virtual port 5173');

  // The IDE auto-opens the preview on listen; give it a moment, and read it back.
  await page.waitForTimeout(8000);
  log('terminal at preview time:\n' + await page.evaluate(() => window.Beownir.terminalText()));
  log('httpStatus: ' + await page.evaluate(() => document.querySelector('#httpStatus')?.textContent));
  log('previewTiming: ' + await page.evaluate(() => document.querySelector('#previewTiming')?.textContent));
  log('preview hidden: ' + await page.evaluate(() => document.querySelector('#preview')?.hidden));
  log('frames: ' + JSON.stringify(page.frames().map(f => f.url() || '(blank)')));
  let frame = null;
  for (const candidate of page.frames()) {
    if (candidate !== page.mainFrame() && (candidate.url().includes('5173') || candidate.url().startsWith('about:srcdoc'))) {
      const hasApp = await candidate.evaluate(() => !!document.querySelector('#app') || document.title === 'Beownir preview').catch(() => false);
      if (hasApp) { frame = candidate; break; }
    }
  }
  if (!frame) {
    for (const candidate of page.frames()) {
      if (candidate !== page.mainFrame()) {
        const hasApp = await candidate.evaluate(() => !!document.querySelector('#app')).catch(() => false);
        if (hasApp) { frame = candidate; break; }
      }
    }
  }
  if (!frame) throw new Error('preview iframe not found');
  log('frame url: ' + frame.url());
  const html = await frame.content().catch(e => 'ERR ' + e.message);
  const marker = String(html).indexOf('beownir-preview/src/main.js');
  log('main.js marker at ' + marker + (marker >= 0 ? ' (srcdoc rewriting loader path)' : ' (native modules path)'));
  await frame.waitForSelector('#app', { timeout: 30000 });
  const initial = await frame.locator('#app').textContent();
  log('preview heading:', JSON.stringify(initial));
  if (initial !== 'VITE_E2E_INITIAL') throw new Error('preview did not render the initial message, got: ' + initial);
  const assetState = await frame.evaluate(() => {
    const img = document.querySelector('#logo');
    return { complete: Boolean(img && img.complete), naturalWidth: (img && img.naturalWidth) || 0, color: getComputedStyle(document.querySelector('#app')).color };
  });
  log('assets: ' + JSON.stringify(assetState));
  if (!assetState.complete || assetState.naturalWidth === 0) throw new Error('logo.svg did not load through the preview');
  if (assetState.color !== 'rgb(1, 2, 3)') throw new Error('style.css was not applied, h1 color = ' + assetState.color);

  let frameNavigations = 0;
  page.on('framenavigated', nav => { if (nav === frame) frameNavigations++; });

  log('console before edit: ' + JSON.stringify(consoleLines.slice(-25)));
  log('editing src/message.js to VITE_E2E_UPDATED');
  await page.evaluate(() => window.Beownir.write('src/message.js', 'export const message = "VITE_E2E_UPDATED";\n'));
  await frame.locator('#app').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => true, null, { timeout: 500 }).catch(() => {});
  let updated = initial;
  for (let attempt = 0; attempt < 60; attempt++) {
    updated = await frame.locator('#app').textContent().catch(() => updated);
    if (updated === 'VITE_E2E_UPDATED') break;
    await page.waitForTimeout(500);
  }
  log('after edit heading:', JSON.stringify(updated), '| frame navigations after edit:', frameNavigations);
  log('console after edit: ' + JSON.stringify(consoleLines.slice(-25)));
  log('terminal at end:\n' + await page.evaluate(() => window.Beownir.terminalText()));
  if (updated !== 'VITE_E2E_UPDATED') throw new Error('HMR did not update the preview DOM, still: ' + updated);
  if (frameNavigations > 0) throw new Error('preview reloaded (navigated) instead of applying HMR; navigations=' + frameNavigations);

  log('PASS: browser-DOM HMR through the real Vite client worked without a reload');
  await browser.close();
  process.exit(0);
})().catch(error => { console.error('[e2e] FAIL:', error); process.exit(1); });
