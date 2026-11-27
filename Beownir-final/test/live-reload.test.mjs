import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The live-reload module lives inside the single-file app. This harness lifts
 * that block out of the app script and runs it against small stubs, so the
 * "detect a change and re-apply it" behaviour is covered without a browser. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'o', 'site', 'index.html');

function liveReloadSource() {
  const html = fs.readFileSync(appPath, 'utf8');
  const app = html.slice(html.lastIndexOf('\n<script>') + 9, html.lastIndexOf('</script>'));
  const start = app.indexOf('/* ---------- live reload ----------');
  const end = app.indexOf('async function loadPreview(options = {}) {', start);
  if (start < 0 || end < 0) throw new Error('live reload block not found in the app script');
  return app.slice(start, end);
}

function createHarness({ stored = null } = {}) {
  const calls = { toast: [], terminal: [], preview: [] };
  const storage = new Map(stored === null ? [] : [['beownir-live-reload', stored]]);
  let requestId = 0;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, attributes: {}, dataset: {}, textContent: '', title: '', setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; } });
    return elements.get(id);
  };
  const source = liveReloadSource();
  const body = `
    let previewLoaded = false, ready = true, busy = false;
    const state = { projectId: 'p1' };
    const $ = selector => { const id = selector.replace(/^#/, ''); return providedElements.has(id) ? providedElements.get(id) : null; };
    const toast = message => messages.toast.push(message);
    const terminalOutput = message => messages.terminal.push(message);
    const cleanTerminal = value => String(value);
    const id = () => 'req-' + (++requestCounter);
    const loadPreview = options => { messages.preview.push(options); return Promise.resolve(); };
    const window = { addEventListener() {}, removeEventListener() {} };
    const document = {};
    ${source}
    return {
      liveReload, initLiveReload, toggleLiveReload, noteFileChange, scheduleLiveReload, refreshPreviewLive, capturePreviewState,
      setPreviewLoaded: value => { previewLoaded = value; },
      setReady: value => { ready = value; },
      setBusy: value => { busy = value; },
      isPreviewLoaded: () => previewLoaded
    };
  `;
  const factory = new Function('providedElements', 'messages', 'requestCounter', 'localStorage', body);
  const known = new Set(['liveReload', 'liveReloadState']);
  const store = { has: id => known.has(id), get: id => element(id) };
  const api = factory(store, calls, requestId, {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value))
  });
  return { api, calls, element, storage };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('live reload defaults to on and honors stored preference', () => {
  const web = createHarness();
  web.api.initLiveReload();
  assert.equal(web.api.liveReload.enabled, true);
  assert.equal(web.element('liveReload').attributes['aria-pressed'], 'true');
  assert.equal(web.element('liveReloadState').textContent, 'Live');

  const disabled = createHarness({ stored: '0' });
  disabled.api.initLiveReload();
  assert.equal(disabled.api.liveReload.enabled, false);
  assert.equal(disabled.element('liveReloadState').textContent, 'Manual');

  const remembered = createHarness({ stored: '1' });
  remembered.api.initLiveReload();
  assert.equal(remembered.api.liveReload.enabled, true);
});

test('toggling live reload persists the choice and reports it', () => {
  const harness = createHarness();
  harness.api.initLiveReload();
  harness.api.toggleLiveReload();
  assert.equal(harness.api.liveReload.enabled, false);
  assert.equal(harness.storage.get('beownir-live-reload'), '0');
  assert.match(harness.calls.toast.at(-1), /Live reload off/);
  harness.api.toggleLiveReload();
  assert.equal(harness.storage.get('beownir-live-reload'), '1');
  assert.match(harness.calls.toast.at(-1), /Live reload on/);
});

test('a saved file schedules one debounced preview refresh', { timeout: 10000 }, async () => {
  const harness = createHarness();
  harness.api.initLiveReload();
  harness.api.setPreviewLoaded(true);
  harness.api.noteFileChange('/project/src/a.js');
  harness.api.noteFileChange('/project/src/b.js');
  harness.api.noteFileChange('/project/src/a.js');
  await wait(120);
  assert.equal(harness.calls.preview.length, 0, 'the refresh waits for the debounce window');
  await wait(600);
  assert.equal(harness.calls.preview.length, 1, 'three edits collapse into one refresh');
  assert.equal(harness.calls.preview[0].preserve, null);
  assert.equal(harness.api.liveReload.paths.size, 0, 'tracked paths are cleared after a refresh');
  assert.equal(harness.element('liveReloadState').textContent, 'Live · updated');
});

test('dependency installs, build output and scratch files never trigger a refresh', { timeout: 10000 }, async () => {
  const harness = createHarness();
  harness.api.initLiveReload();
  harness.api.setPreviewLoaded(true);
  for (const path of ['/project/node_modules/react/index.js', '/project/.beownir/runtime/pako.js', '/project/dist/app.js', '/project/.next/server/page.js', '/tmp/scratch.txt', 'relative.js']) harness.api.noteFileChange(path);
  await wait(700);
  assert.equal(harness.calls.preview.length, 0);
});

test('nothing refreshes while a command is running, and the update is retried', { timeout: 10000 }, async () => {
  const harness = createHarness();
  harness.api.initLiveReload();
  harness.api.setPreviewLoaded(true);
  harness.api.setBusy(true);
  harness.api.noteFileChange('/project/src/a.js');
  await wait(600);
  assert.equal(harness.calls.preview.length, 0, 'busy runtime defers the refresh');
  harness.api.setBusy(false);
  await wait(1400);
  assert.equal(harness.calls.preview.length, 1, 'the deferred refresh still happens');
});

test('a refresh in flight queues one follow-up instead of stacking', { timeout: 10000 }, async () => {
  const harness = createHarness();
  harness.api.initLiveReload();
  harness.api.setPreviewLoaded(true);
  const first = harness.api.refreshPreviewLive('manual');
  harness.api.noteFileChange('/project/src/a.js');
  await wait(700);
  await first;
  await wait(300);
  assert.equal(harness.calls.preview.length, 2, 'one running refresh plus one queued follow-up');
});

test('capturePreviewState resolves null without a live preview frame', async () => {
  const harness = createHarness();
  assert.equal(await harness.api.capturePreviewState(20), null);
});
