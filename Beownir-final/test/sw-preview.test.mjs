import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/* The service worker serves preview ports by forwarding each request to the open IDE tab.
 * The worker is loaded for real; the browser parts (clients, caches, registration) are fakes
 * that only record what the worker asks for. */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'o', 'site', 'coi-sw.js'), 'utf8');
const ORIGIN = 'https://ide.example.app';

function loadWorker({ windows, shellBody = 'shell' }) {
  const listeners = {};
  const posted = [];
  const cache = { add: async () => {}, put: async () => {}, match: async () => undefined, keys: async () => [] };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map(w => ({
        url: w.url,
        postMessage(message, transfer) { posted.push({ message, transfer, client: w }); if (w.answer) w.answer(message, transfer[0]); },
      })),
    },
    registration: { unregister: async () => true },
  };
  const sandbox = {
    self, Response, Request, Headers, URL, MessageChannel, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [], delete: async () => true },
    fetch: async () => new Response(shellBody, { status: 200, headers: { 'content-type': 'text/html' } }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'coi-sw.js' });
  const fetchEvent = (url, method = 'GET', body) => {
    const request = new Request(url, { method, body });
    let answer;
    const event = { request, respondWith: promise => { answer = promise; } };
    listeners.fetch(event);
    return { event, answer: () => answer };
  };
  return { fetchEvent, posted };
}

const kernelTab = answer => ({
  url: ORIGIN + '/',
  answer(message, port) {
    const body = new TextEncoder().encode('<h1>' + message.method + ' ' + message.url + '</h1>');
    port.postMessage({ status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  },
  ...answer,
});

test('a preview request is forwarded to the IDE tab with its port, path, method and headers, and the reply is returned', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  const { answer } = worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/hello?x=1');
  const response = await answer();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>GET /hello?x=1</h1>');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'credentialless', 'isolation headers still apply');
  const sent = worker.posted[0].message;
  assert.equal(sent.type, 'beownir-sw-http');
  assert.equal(sent.port, 3000);
  assert.equal(sent.url, '/hello?x=1');
  assert.equal(sent.method, 'GET');
});

test('a preview root maps to "/"', async () => {
  const worker = loadWorker({ windows: [kernelTab()] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/8080').answer();
  assert.equal(await response.text(), '<h1>GET /</h1>');
});

test('HEAD returns the status and headers without a body', async () => {
  const worker = loadWorker({ windows: [kernelTab()] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/page', 'HEAD').answer();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('without an open IDE tab the preview says so instead of hanging', async () => {
  const worker = loadWorker({ windows: [{ url: ORIGIN + '/__beownir_preview__/3000/' }] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Open the Beownir IDE tab/);
});

test('an error from the IDE tab becomes a 502 with the reason', async () => {
  const failing = { url: ORIGIN + '/', answer(message, port) { port.postMessage({ error: 'ECONNREFUSED: nothing listens on port 3000' }); } };
  const worker = loadWorker({ windows: [failing] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /ECONNREFUSED/);
});

test('invalid preview ports are rejected without contacting the IDE', async () => {
  const worker = loadWorker({ windows: [kernelTab()] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/70000/x').answer();
  assert.equal(response.status, 404);
  assert.equal(worker.posted.length, 0);
});

test('ordinary shell requests never reach the preview path', async () => {
  const worker = loadWorker({ windows: [kernelTab()], shellBody: 'the shell' });
  const response = await worker.fetchEvent(ORIGIN + '/index.html').answer();
  assert.equal(await response.text(), 'the shell');
  assert.equal(worker.posted.length, 0, 'the IDE tab must not be asked for shell files');
});

test('the IDE tab itself is never chosen as the preview client when only the preview tab is open', async () => {
  const previewTab = { url: ORIGIN + '/__beownir_preview__/3000/', answer(message, port) { port.postMessage({ status: 200, headers: {}, body: new Uint8Array() }); } };
  const worker = loadWorker({ windows: [previewTab] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(response.status, 503, 'a preview tab cannot answer its own request');
});
