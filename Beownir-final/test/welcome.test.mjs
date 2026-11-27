/**
 * The first-run card and the "This device" help tab both read the same probe.
 * That probe is the product's promise about what works, so it is tested here by
 * evaluating the shipped source (not a copy of it) against simulated
 * environments: isolated Chromium, a plain static host, and a browser without
 * OPFS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root } from '../tools/build-standalone.mjs';

const page = fs.readFileSync(path.join(root, 'o', 'site', 'index.html'), 'utf8');

/** Pulls the welcome/probe block out of the app so it can be exercised. */
function extractProbe() {
  const start = page.indexOf('  const WELCOME_KEY');
  assert.ok(start > 0, 'the welcome block is present in the shipped page');
  const end = page.indexOf('  function projectMenu()', start);
  assert.ok(end > start, 'the welcome block ends where the project menu begins');
  return page.slice(start, end);
}

const ELEMENT = () => {
  const node = {
    tag: 'div', className: '', textContent: '', children: [], dataset: {},
    append(...items) { for (const item of items) this.children.push(item); },
    replaceChildren(...items) { this.children = items; },
    addEventListener() {},
  };
  return node;
};

function load({ isolated = true, sab = true, jspi = true, opfs = true, shell = 'active', host = false, stored = null, hostname = 'example.test', swController = false } = {}) {
  const calls = { dialogs: [], buttons: [], stored: stored ? { ...stored } : {}, templates: 0, help: [] };
  const sandbox = {
    console,
    setTimeout: callback => { callback(); return 0; },
    make: (tag, className = '', text = '') => { const node = ELEMENT(); node.tag = tag; node.className = className; node.textContent = text; return node; },
    button: (label, className, action) => ({ label, className, action }),
    dialog: (title, eyebrow) => {
      const view = { title, eyebrow, body: ELEMENT(), footer: ELEMENT(), shown: false, closed: false, listeners: {} };
      view.node = { addEventListener: (name, fn) => { view.listeners[name] = fn; }, showModal: () => { view.shown = true; }, close: () => { view.closed = true; if (view.listeners.close) view.listeners.close(); } };
      view.show = () => { view.shown = true; };
      view.close = () => { view.closed = true; if (view.listeners.close) view.listeners.close(); };
      calls.dialogs.push(view);
      return view;
    },
    openTemplates: () => { calls.templates += 1; },
    helpDialog: section => { calls.help.push(section); },
    localStorage: {
      getItem: key => (key in calls.stored ? calls.stored[key] : null),
      setItem: (key, value) => { calls.stored[key] = String(value); },
    },
    navigator: {
      storage: opfs ? { getDirectory: () => {} } : {},
      serviceWorker: swController ? { controller: {} } : {},
    },
    location: { hostname },
    WebAssembly: jspi ? { Suspending: function Suspending() {} } : {},
    SharedArrayBuffer: sab ? function SharedArrayBuffer() {} : undefined,
    nativeMode: () => host,
  };
  /* The shipped probe reads these off `window`, so the stub has to expose them
   * there too — in a browser window *is* globalThis. */
  sandbox.window = {
    crossOriginIsolated: isolated,
    Beownir: { version: '9.9.9-test' },
    __beownirShell: shell === null ? undefined : { state: shell },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractProbe(), sandbox, { filename: 'welcome-block.js' });
  return { sandbox, calls };
}

const byName = rows => Object.fromEntries(rows.map(row => [row.name, row]));

test('static-host Install and Build actions use the Web mode runtime', () => {
  const setup = page.slice(page.indexOf('  function npmDialog(){'), page.indexOf('  // Explicit built-in-template lifecycle.'));
  assert.match(setup, /nativeMode\(\)\s*\?\s*'pnpm install --ignore-scripts'\s*:\s*'npm install'/);
  assert.match(setup, /nativeMode\(\)\s*\?\s*'pnpm build'\s*:\s*'npm run build'/);
  assert.match(setup, /\[\['Install declared dependencies','npm install'\],\['Build project script','npm run build'\]\]/);
  assert.match(setup, /Web mode includes an npm, pnpm, yarn, and bun-compatible registry installer/);
  assert.match(setup, /Web mode does not compile native C\/C\+\+ addons/);
});

test('an isolated Chromium unlocks the native capabilities', () => {
  const { sandbox } = load();
  const rows = byName(sandbox.probeCapabilities());
  for (const name of ['Cross-origin isolation', 'SharedArrayBuffer', 'Native browser-WASM profile', 'OPFS execution mounts', 'Offline shell (service worker)', 'Virtual loopback TCP & UDP sockets', 'Virtual loopback TLS & HTTP/2', 'Framework dev servers (Vite, Next.js, Nuxt)', 'X.509 certificate parsing & asymmetric crypto', 'Outbound HTTPS relay (registry & configured domains)']) {
    assert.equal(rows[name].ok, true, name + ' is reported as available');
  }
  assert.equal(rows['Open a preview in another tab (host bridge)'].ok, false, 'no host or controlling service worker is active in this scenario');
  assert.equal(rows['External raw sockets & unfiltered network'].ok, false, 'external non-HTTP raw sockets remain unsupported');
  assert.equal(rows['Unmapped native addons & OS binaries'].ok, false, 'unmapped native binaries remain unsupported');
  assert.equal(rows['TLS, raw TCP/UDP, unmapped native addons'], undefined, 'TCP/UDP is not misreported as unavailable');
});

test('an active service worker unlocks cross-tab preview on both localhost and served origins', () => {
  const local = byName(load({ hostname: '127.0.0.1', swController: true }).sandbox.probeCapabilities());
  assert.equal(local['Open a preview in another tab (host bridge)'].ok, true);
  assert.match(local['Open a preview in another tab (host bridge)'].detail, /__beownir_preview__/);
  assert.match(local['Framework dev servers (Vite, Next.js, Nuxt)'].detail, /HMR/);

  const hosted = byName(load({ hostname: 'ide.example.test', swController: true }).sandbox.probeCapabilities());
  assert.equal(hosted['Open a preview in another tab (host bridge)'].ok, true);
  assert.match(hosted['Open a preview in another tab (host bridge)'].detail, /__beownir_preview__/);
});

test('a plain static host reports exactly what is missing and why', () => {
  const { sandbox } = load({ isolated: false, sab: false, jspi: false, shell: null, host: false });
  const rows = byName(sandbox.probeCapabilities());
  assert.equal(rows['Cross-origin isolation'].ok, false);
  assert.match(rows['Cross-origin isolation'].detail, /COOP\/COEP/, 'the fix is named');
  assert.equal(rows['SharedArrayBuffer'].ok, false);
  assert.equal(rows['Native browser-WASM profile'].ok, false);
  assert.match(rows['Offline shell (service worker)'].detail, /file:\/\//, 'the file:// case is explained');
  // What does not depend on the environment keeps working.
  for (const name of ['Editor, terminal, virtual filesystem', 'npm & pnpm installs', 'Servers and the preview panel', 'Virtual loopback TCP & UDP sockets', 'Virtual loopback TLS & HTTP/2', 'Framework dev servers (Vite, Next.js, Nuxt)', 'X.509 certificate parsing & asymmetric crypto', 'Outbound HTTPS relay (registry & configured domains)']) {
    assert.equal(rows[name].ok, true, name + ' stays available');
  }
  assert.equal(rows['External raw sockets & unfiltered network'].ok, false, 'external raw sockets and unfiltered domains are never claimed');
  assert.equal(rows['Unmapped native addons & OS binaries'].ok, false, 'unmapped native binaries are never claimed');
});

test('OPFS and the host bridge are reported independently', () => {
  const { sandbox } = load({ opfs: false, host: true, shell: 'failed' });
  const rows = byName(sandbox.probeCapabilities());
  assert.equal(rows['OPFS execution mounts'].ok, false);
  assert.match(rows['OPFS execution mounts'].detail, /IndexedDB/);
  assert.equal(rows['Open a preview in another tab (host bridge)'].ok, true);
  assert.match(rows['Offline shell (service worker)'].detail, /beownir-host\.mjs/);
});

test('worker stop never auto-restarts new workers and SW open-in-tab button stays wired', () => {
  assert.match(page, /async function stopRuntime\(/);
  assert.match(page, /bind\('#stop',\s*\(\)\s*=>\s*stopRuntime\(\{\s*announce:\s*true\s*\}\)\)/);
  assert.match(page, /stop:\s*\(\)\s*=>\s*stopRuntime\(\{\s*announce:\s*true\s*\}\)/);
  assert.match(page, /if\s*\(data === '\\x03'\)\s*\{[^}]*stopRuntime\(\{\s*announce:\s*true\s*\}\)/);
  assert.match(page, /if\s*\(swPreviewBridgeAvailable\(\)\)\s*\{\s*openBtn\.dataset\.url\s*=\s*'\/__beownir_preview__\/'\s*\+\s*port\s*\+\s*path;\s*openBtn\.hidden\s*=\s*false;/);
});

test('the capability list marks each row and carries its reason', () => {
  const { sandbox } = load({ isolated: false });
  const list = sandbox.capabilityList();
  assert.equal(list.tag, 'ul');
  assert.ok(list.children.length >= 10, 'every capability has a row');
  const states = list.children.map(item => item.dataset.state);
  assert.ok(states.includes('ok') && states.includes('no'), 'both outcomes are marked');
  const isolationRow = list.children.find(item => item.children[1].textContent.startsWith('Cross-origin isolation'));
  assert.equal(isolationRow.dataset.state, 'no');
  assert.match(isolationRow.children[2].textContent, /COOP/);
});

test('the first-run card appears once and remembers being dismissed', () => {
  const first = load();
  first.sandbox.maybeWelcome();
  assert.equal(first.calls.dialogs.length, 1, 'one dialog on a fresh visit');
  const view = first.calls.dialogs[0];
  assert.equal(view.shown, true);
  assert.match(view.eyebrow, /9\.9\.9-TEST/, 'the eyebrow carries the app version');
  assert.match(view.title, /what works/i);
  const actions = view.footer.children.map(entry => entry.label);
  assert.deepEqual(actions, ['Compatibility notes', 'Choose a template', 'Start building']);
  view.close();
  assert.equal(first.calls.stored['beownir-welcome-v1'], '1', 'dismissal is remembered');

  const second = load({ stored: { 'beownir-welcome-v1': '1' } });
  second.sandbox.maybeWelcome();
  assert.equal(second.calls.dialogs.length, 0, 'no dialog once it has been seen');
});

test('the card actions open the right panels', () => {
  const { sandbox, calls } = load();
  sandbox.maybeWelcome();
  const view = calls.dialogs[0];
  const action = label => view.footer.children.find(entry => entry.label === label).action;
  action('Compatibility notes')();
  assert.deepEqual(calls.help, ['guide']);
  action('Choose a template')();
  assert.equal(calls.templates, 1);
});

test('hosting & release and guide dialogs reflect virtualized TCP/UDP and active runtime modes', () => {
  assert.doesNotMatch(page, /Exact-artifact release gate|production-certified|deliberately blocked until every required test/);
  assert.doesNotMatch(page, /raw TCP\/UDP\/TLS sockets/);
  assert.match(page, /Virtual loopback TCP & UDP sockets/);
  assert.match(page, /Framework runtime matrix/);
});

