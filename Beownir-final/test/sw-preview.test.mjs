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

function loadWorker({ windows, shellBody = 'shell', origin = ORIGIN, scope }) {
  const listeners = {};
  const posted = [];
  const cache = { add: async () => {}, put: async () => {}, match: async () => undefined, keys: async () => [] };
  const self = {
    location: { origin },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map(w => ({
        id: w.id,
        url: w.url,
        postMessage(message, transfer) { posted.push({ message, transfer, client: w }); if (w.answer) w.answer(message, transfer[0]); },
      })),
    },
    registration: { scope, unregister: async () => true },
  };
  const sandbox = {
    self, Response, Request, Headers, URL, MessageChannel, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    caches: { open: async () => cache, match: async () => undefined, keys: async () => [], delete: async () => true },
    fetch: async () => new Response(shellBody, { status: 200, headers: { 'content-type': 'text/html' } }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'coi-sw.js' });
  const fetchEvent = (url, method = 'GET', body, extra = {}) => {
    const request = new Request(url, { method, body, headers: extra.headers });
    let answer;
    const event = { request, clientId: extra.clientId, resultingClientId: extra.resultingClientId, respondWith: promise => { answer = promise; } };
    listeners.fetch(event);
    return { event, answer: () => answer };
  };
  const messageEvent = (data, sourceId) => {
    if (listeners.message) listeners.message({ data, source: sourceId ? { id: sourceId } : null });
  };
  return { fetchEvent, messageEvent, posted };
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

test('after a preview navigation claims a client, root-relative subresources reach the same virtual port', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET', undefined, { resultingClientId: 'client-1' }).answer();
  assert.equal(worker.posted.length, 1);
  const response = await worker.fetchEvent(ORIGIN + '/src/main.ts', 'GET', undefined, { clientId: 'client-1' }).answer();
  assert.equal(await response.text(), '<h1>GET /src/main.ts</h1>');
  const sent = worker.posted.at(-1).message;
  assert.equal(sent.port, 3000);
  assert.equal(sent.url, '/src/main.ts');
});

test('an unclaimed client is never routed to a preview port', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET', undefined, { resultingClientId: 'client-1' }).answer();
  await worker.fetchEvent(ORIGIN + '/src/main.ts', 'GET', undefined, { clientId: 'client-2' }).answer();
  assert.equal(worker.posted.length, 1, 'the IDE tab must not be asked for unclaimed clients');
});

test('an invalid port under the preview prefix is rejected even for a claimed client', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET', undefined, { resultingClientId: 'client-1' }).answer();
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/70000/x', 'GET', undefined, { clientId: 'client-1' }).answer();
  assert.equal(response.status, 404);
  assert.equal(worker.posted.length, 1, 'an invalid port must not reach the IDE tab');
});

test('preview HTML documents get the WebSocket shim injected; other responses do not', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  const doc = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET', undefined, { headers: { 'sec-fetch-dest': 'iframe' } }).answer();
  const text = await doc.text();
  assert.match(text, /__beownirSwWsShim/);
  assert.match(text, /BroadcastChannel\('beownir-preview-ws'\)/);
  assert.equal(doc.headers.get('content-length'), null, 'stale content-length must be dropped');
  const plain = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET').answer();
  assert.equal(await plain.text(), '<h1>GET /</h1>', 'non-document responses pass through unchanged');
});

test('service-worker VirtualCookieJar isolates cookies per preview port and strips Set-Cookie from host headers', async () => {
  const seen = [];
  const tab = {
    url: ORIGIN + '/',
    answer(message, port) {
      seen.push({ port: message.port, url: message.url, cookie: message.headers.cookie || '' });
      if (message.url === '/login') {
        port.postMessage({ status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['sid=p' + message.port + '; Path=/; HttpOnly', 'prefs=dark; Path=/'] }, body: new TextEncoder().encode('ok') });
      } else if (message.url === '/logout') {
        port.postMessage({ status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=; Path=/; Max-Age=0' }, body: new TextEncoder().encode('bye') });
      } else {
        port.postMessage({ status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('hi') });
      }
    },
  };
  const worker = loadWorker({ windows: [tab] });
  const loginRes = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/login').answer();
  assert.equal(loginRes.headers.get('set-cookie'), null, 'Set-Cookie must not leak into IDE host origin');

  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/me').answer();
  assert.match(seen[seen.length - 1].cookie, /sid=p3000/);
  assert.match(seen[seen.length - 1].cookie, /prefs=dark/);

  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/4000/me').answer();
  assert.equal(seen[seen.length - 1].cookie, '', 'cookies on port 3000 must never leak to port 4000');

  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/logout').answer();
  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/me').answer();
  assert.ok(!seen[seen.length - 1].cookie.includes('sid='), 'Max-Age=0 deletes sid');
  assert.match(seen[seen.length - 1].cookie, /prefs=dark/);
});

test('service-worker routes wildcard subdomain p<port>-<id> hostnames directly to that virtual port', async () => {
  const seen = [];
  const subOrigin = 'https://p3005-alpha.preview.example.test';
  const worker = loadWorker({
    origin: subOrigin,
    windows: [{
      url: subOrigin + '/',
      answer(message, port) {
        seen.push(message);
        port.postMessage({ status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<html><head></head><body>sub</body></html>') });
      },
    }],
  });
  // Wait: kernelClient filters out preview clients on /__beownir_preview__, so subdomain preview tests client routing cleanly
  const resp = await worker.fetchEvent(subOrigin + '/hello?a=1', 'GET', undefined, { headers: { 'sec-fetch-dest': 'iframe' } }).answer();
  assert.equal(resp.status, 200);
  assert.equal(seen[0].port, 3005);
  assert.equal(seen[0].url, '/hello?a=1');
  const html = await resp.text();
  assert.match(html, /__beownirSwWsShim/);
});

test('service-worker routes subpath-scoped preview requests when hosted under a subdirectory', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab], scope: ORIGIN + '/o/site/' });
  const response = await worker.fetchEvent(ORIGIN + '/o/site/__beownir_preview__/3000/hello?x=1').answer();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>GET /hello?x=1</h1>');
});

test('service-worker rewrites 3xx Location headers to keep redirects on the preview route', async () => {
  const tab = {
    url: ORIGIN + '/',
    answer(message, port) {
      port.postMessage({ status: 302, statusMessage: 'Found', headers: { location: '/dashboard?ok=1' }, body: new Uint8Array() });
    },
  };
  const worker = loadWorker({ windows: [tab] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/__beownir_preview__/3000/dashboard?ok=1');

  const absTab = {
    url: ORIGIN + '/',
    answer(message, port) {
      port.postMessage({ status: 307, statusMessage: 'Temporary Redirect', headers: { Location: 'http://localhost:3000/next' }, body: new Uint8Array() });
    },
  };
  const worker2 = loadWorker({ windows: [absTab] });
  const response2 = await worker2.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(response2.headers.get('location'), '/__beownir_preview__/3000/next');
});

test('claimed preview navigation propagates the virtual port to the resulting client', async () => {
  const tab = kernelTab();
  const worker = loadWorker({ windows: [tab] });
  await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/', 'GET', undefined, { resultingClientId: 'c-1' }).answer();
  await worker.fetchEvent(ORIGIN + '/about', 'GET', undefined, { clientId: 'c-1', resultingClientId: 'c-2' }).answer();
  const sub = await worker.fetchEvent(ORIGIN + '/about.js', 'GET', undefined, { clientId: 'c-2' }).answer();
  assert.equal(await sub.text(), '<h1>GET /about.js</h1>');
});

test('multi-tab kernelClient probes skip non-IDE tabs and route to the tab running the port', async () => {
  const nonIde = { id: 'tab-non-ide', url: ORIGIN + '/docs.html' };
  const idleIde = {
    id: 'tab-idle',
    url: ORIGIN + '/',
    answer(message, port) {
      if (message.type === 'beownir-sw-probe') { port.postMessage({ ok: true, hasPort: false }); return; }
      port.postMessage({ status: 500, headers: {}, body: new TextEncoder().encode('WRONG_IDLE_TAB') });
    },
  };
  const activeIde = {
    id: 'tab-active',
    url: ORIGIN + '/',
    answer(message, port) {
      if (message.type === 'beownir-sw-probe') { port.postMessage({ ok: true, hasPort: message.port === 3000 }); return; }
      port.postMessage({ status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('FROM_ACTIVE_TAB') });
    },
  };
  const worker = loadWorker({ windows: [nonIde, idleIde, activeIde] });
  const response = await worker.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(await response.text(), 'FROM_ACTIVE_TAB');

  const secondActive = {
    id: 'tab-second',
    url: ORIGIN + '/',
    answer(message, port) {
      if (message.type === 'beownir-sw-probe') { port.postMessage({ ok: true, hasPort: message.port === 3000 }); return; }
      port.postMessage({ status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('FROM_SECOND_TAB') });
    },
  };
  const worker2 = loadWorker({ windows: [activeIde, secondActive] });
  worker2.messageEvent({ type: 'beownir-sw-open', port: 3000 }, 'tab-second');
  const response2 = await worker2.fetchEvent(ORIGIN + '/__beownir_preview__/3000/').answer();
  assert.equal(await response2.text(), 'FROM_SECOND_TAB');
});

