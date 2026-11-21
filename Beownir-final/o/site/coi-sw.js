/* Beownir service worker: cross-origin isolation plus an offline app shell.
 *
 * One worker per scope, so this file does both jobs:
 *   1. injects COOP/COEP/CORP so the page becomes cross-origin isolated on any
 *      static host (needed for SharedArrayBuffer, JSPI and the WASIX profile);
 *   2. caches the single-file shell so the IDE still boots with no network.
 *
 * It deliberately does not touch the npm registry: package downloads are the
 * installer's business and must never be served from a stale cache.
 */
const SHELL_CACHE = 'beownir-shell-v3';
const SHELL_URLS = ['/', '/index.html'];
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Origin-Agent-Cluster': '?1',
};

const cacheable = url =>
  url.origin === self.location.origin &&
  !url.pathname.startsWith('/healthz') &&
  !url.pathname.endsWith('.map');

const isolated = response => {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

/** Network first for documents (so an update lands immediately), cache second. */
async function navigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true }) ||
      (await caches.open(SHELL_CACHE).then(cache => cache.match('/index.html') || cache.match('/')));
    if (cached) return cached;
    throw error;
  }
}

/** Stale-while-revalidate for same-origin assets: instant, then refreshed. */
async function asset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(response => {
      if (response && response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  throw new Error('offline and not cached: ' + request.url);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const url of SHELL_URLS) {
      try { await cache.add(new Request(new URL(url, self.location.origin).href, { cache: 'reload' })); } catch { /* first install may race the server */ }
    }
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('beownir-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('beownir-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  const reply = value => { try { event.source?.postMessage(value); } catch { /* client is gone */ } };
  if (data.type === 'deregister') { event.waitUntil(self.registration.unregister()); return; }
  if (data.type === 'skip-waiting') { event.waitUntil(self.skipWaiting()); return; }
  if (data.type === 'clear-cache') {
    event.waitUntil((async () => {
      await caches.delete(SHELL_CACHE);
      const cache = await caches.open(SHELL_CACHE);
      for (const url of SHELL_URLS) { try { await cache.add(new Request(new URL(url, self.location.origin).href, { cache: 'reload' })); } catch { /* offline already */ } }
      reply({ type: 'shell-cleared' });
    })());
    return;
  }
  if (data.type === 'status') {
    event.waitUntil((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const entries = await cache.keys();
      reply({ type: 'shell-status', cached: entries.length, urls: entries.map(request => new URL(request.url).pathname).slice(0, 20), version: SHELL_CACHE });
    })());
    return;
  }
});

/* Preview routing: /__beownir_preview__/<port>/<path> on this origin is answered by the IDE
 * tab that owns the virtual servers. The worker forwards the request to that tab over a
 * MessageChannel; the tab routes it through the same kernel path the in-page preview uses.
 *
 * Same-origin preview mode (loopback builds only, chosen by the IDE shell): the preview
 * document is served from this origin so ES modules, assets and HMR WebSockets load
 * natively — no srcdoc rewriting. Trade-off vs the srcdoc sandbox: the preview runs with
 * same-origin privileges. That is acceptable on a developer's machine for their own
 * project, and deliberately not what the deployed IDE uses for untrusted code. The IDE
 * decides which mode to use; this worker just serves both faithfully. */
const PREVIEW_PREFIX = '/__beownir_preview__/';
const PREVIEW_TIMEOUT_MS = 20000;
/* After a preview document loads, remember which port its client belongs to so
 * root-relative subresource URLs (/src/main.ts, /@vite/client, ...) also route
 * to the virtual server. Claims are re-established on every preview navigation;
 * a worker restart just means the next refresh re-claims. */
const claimedPreviewClients = new Map();
const CLIENT_CLAIM_TTL = 30 * 60 * 1000;
function claimPreviewClient(clientId, port) {
  if (!clientId) return;
  if (claimedPreviewClients.size > 128) claimedPreviewClients.clear();
  claimedPreviewClients.set(clientId, { port, at: Date.now() });
}
function claimedPreviewPort(clientId) {
  const entry = claimedPreviewClients.get(clientId);
  if (!entry) return 0;
  if (Date.now() - entry.at > CLIENT_CLAIM_TTL) { claimedPreviewClients.delete(clientId); return 0; }
  return entry.port;
}
/* Injected into preview HTML documents. Replaces window.WebSocket with a
 * BroadcastChannel-backed implementation that reaches the IDE tab, which
 * forwards to the same kernel upgrade path the sandboxed preview uses. This is
 * what lets a real Vite HMR client connect from the same-origin preview. */
const PREVIEW_WS_SHIM = `(function () {
  if (window.__beownirSwWsShim) return;
  window.__beownirSwWsShim = true;
  var prefix = '/__beownir_preview__/';
  var previewPort = 0;
  if (window.location.pathname.indexOf(prefix) === 0) {
    var rest = window.location.pathname.slice(prefix.length);
    var slash = rest.indexOf('/');
    previewPort = Number(slash < 0 ? rest : rest.slice(0, slash)) || 0;
  }
  var NativeWebSocket = window.WebSocket;
  var bc = new BroadcastChannel('beownir-preview-ws');
  var nextId = 0;
  var active = {};
  function fire(self, type, event) {
    event = event || {};
    event.target = self;
    event.currentTarget = self;
    var listeners = (self._listeners[type] || []).slice();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i].call(self, event); } catch (error) { setTimeout(function () { throw error; }, 0); }
    }
    var handler = self['on' + type];
    if (handler) { try { handler.call(self, event); } catch (error) { setTimeout(function () { throw error; }, 0); } }
  }
  function ShimSocket(url, protocols) {
    if (!(this instanceof ShimSocket)) return new ShimSocket(url, protocols);
    var parsed;
    try { parsed = new URL(url, window.location.href); } catch (error) { throw new SyntaxError('Invalid WebSocket URL: ' + url); }
    var host = parsed.hostname;
    if (host !== window.location.hostname && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::1]') {
      return new NativeWebSocket(url, protocols);
    }
    var self = this;
    this._uid = 'sw-' + (++nextId) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    this.url = String(url);
    this.readyState = 0;
    this.protocol = '';
    this.extensions = '';
    this.bufferedAmount = 0;
    this.binaryType = 'blob';
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this._listeners = {};
    active[this._uid] = this;
    var list = Array.isArray(protocols) ? protocols.map(String) : protocols ? String(protocols).split(',').map(function (item) { return item.trim(); }).filter(Boolean) : [];
    bc.postMessage({ type: 'ws', op: 'open', id: this._uid, port: previewPort || Number(parsed.port) || 80, url: (parsed.pathname || '/') + (parsed.search || ''), protocols: list });
    this._connectTimer = setTimeout(function () {
      if (self.readyState === 0) {
        self.readyState = 3;
        fire(self, 'error', { message: 'Virtual WebSocket connect timeout' });
        fire(self, 'close', { code: 1006, reason: 'connect timeout', wasClean: false });
        delete active[self._uid];
      }
    }, 10000);
  }
  ShimSocket.prototype.CONNECTING = 0;
  ShimSocket.prototype.OPEN = 1;
  ShimSocket.prototype.CLOSING = 2;
  ShimSocket.prototype.CLOSED = 3;
  ShimSocket.CONNECTING = 0;
  ShimSocket.OPEN = 1;
  ShimSocket.CLOSING = 2;
  ShimSocket.CLOSED = 3;
  ShimSocket.prototype.send = function (data) {
    if (this.readyState === 0) throw new DOMException('Still CONNECTING', 'InvalidStateError');
    if (this.readyState >= 2) return;
    if (typeof data === 'string') { bc.postMessage({ type: 'ws', op: 'send', id: this._uid, data: data, binary: false }); return; }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      var uid = this._uid;
      data.arrayBuffer().then(function (buffer) { bc.postMessage({ type: 'ws', op: 'send', id: uid, data: new Uint8Array(buffer), binary: true }); });
      return;
    }
    var bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data.slice(0));
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (bytes) { bc.postMessage({ type: 'ws', op: 'send', id: this._uid, data: bytes, binary: true }); return; }
    bc.postMessage({ type: 'ws', op: 'send', id: this._uid, data: String(data), binary: false });
  };
  ShimSocket.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    bc.postMessage({ type: 'ws', op: 'close', id: this._uid, code: code || 1000, reason: reason || '' });
  };
  ShimSocket.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== 'function') return;
    var listeners = this._listeners[type] || (this._listeners[type] = []);
    if (listeners.indexOf(listener) < 0) listeners.push(listener);
  };
  ShimSocket.prototype.removeEventListener = function (type, listener) {
    var listeners = this._listeners[type];
    if (!listeners) return;
    var index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
  ShimSocket.prototype.dispatchEvent = function (event) { fire(this, event.type, event); return true; };
  bc.onmessage = function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'wsevent') return;
    var self = active[d.id];
    if (!self) return;
    if (d.event === 'open') {
      clearTimeout(self._connectTimer);
      self.readyState = 1;
      self.protocol = d.protocol || '';
      fire(self, 'open', {});
    } else if (d.event === 'message') {
      var data = d.data;
      if (d.binary) {
        if (self.binaryType === 'arraybuffer') {
          if (data instanceof Uint8Array) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
          data = new Blob([data]);
        }
      }
      fire(self, 'message', { data: data });
    } else if (d.event === 'error') {
      fire(self, 'error', { message: d.message || 'WebSocket error' });
    } else if (d.event === 'close') {
      clearTimeout(self._connectTimer);
      self.readyState = 3;
      fire(self, 'close', { code: d.code || 1006, reason: d.reason || '', wasClean: d.code === 1000 });
      delete active[d.id];
    }
  };
  window.WebSocket = ShimSocket;
})();`;
async function injectPreviewScripts(response, request) {
  var type = response.headers.get('content-type') || '';
  if (type.toLowerCase().indexOf('text/html') < 0) return response;
  var destination = request.destination || String(request.headers.get('sec-fetch-dest') || '').toLowerCase();
  var isDocument = request.mode === 'navigate' || destination === 'document' || destination === 'iframe' || destination === 'frame';
  if (!isDocument) return response;
  try {
    var body = await response.text();
    var shim = '<script>' + PREVIEW_WS_SHIM + '<\/script>';
    var headOpen = body.indexOf('<head');
    if (headOpen >= 0) {
      var close = body.indexOf('>', headOpen);
      body = close >= 0 ? body.slice(0, close + 1) + shim + body.slice(close + 1) : shim + body;
    } else {
      body = shim + body;
    }
    var headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    return response;
  }
}
const textResponse = (message, status) => new Response(message, {
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

function previewRoute(url) {
  const match = /^\/__beownir_preview__\/(\d{1,5})(\/[^]*)?$/.exec(url.pathname);
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  return { port, path: (match[2] || '/') + url.search };
}

async function kernelClient() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.find(client => !new URL(client.url).pathname.startsWith(PREVIEW_PREFIX)) || null;
}

async function previewResponse(request, port, path) {
  const client = await kernelClient();
  if (!client) return textResponse('Open the Beownir IDE tab on this site to serve preview port ' + port + '.', 503);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
  const channel = new MessageChannel();
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('the IDE tab did not answer in time')); }, PREVIEW_TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data && data.error) reject(new Error(data.error)); else resolve(data);
    };
  });
  client.postMessage({
    type: 'beownir-sw-http', port, url: path, method: request.method,
    headers: Object.fromEntries(request.headers), body,
  }, [channel.port2]);
  const result = await reply;
  const noBody = [101, 204, 205, 304].includes(result.status) || request.method === 'HEAD';
  return new Response(noBody ? null : result.body, {
    status: result.status, statusText: result.statusMessage || '', headers: result.headers || {},
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith(PREVIEW_PREFIX)) {
      const explicit = previewRoute(url);
      if (!explicit) {
        event.respondWith(Promise.resolve(textResponse('Not a preview address.', 404)).then(isolated));
        return;
      }
      claimPreviewClient(event.resultingClientId || event.clientId, explicit.port);
      event.respondWith(previewResponse(request, explicit.port, explicit.path)
        .then(response => injectPreviewScripts(response, request))
        .catch(error => textResponse('Preview failed: ' + error.message, 502))
        .then(isolated));
      return;
    }
    // Not a preview address: after a preview document claimed this client,
    // its root-relative subresources route to the same virtual port.
    const claimedPort = claimedPreviewPort(event.clientId);
    if (claimedPort) {
      const path = url.pathname + url.search;
      event.respondWith(previewResponse(request, claimedPort, path)
        .then(response => injectPreviewScripts(response, request))
        .catch(error => textResponse('Preview failed: ' + error.message, 502))
        .then(isolated));
      return;
    }
  }

  // Cross-origin traffic (the npm registry) is never cached or rewritten beyond
  // the isolation headers the page needs to keep its own guarantees.
  if (!cacheable(url)) {
    event.respondWith(fetch(request).then(isolated).catch(() => Response.error()));
    return;
  }

  // Range requests belong to the streaming installer: never intercept them.
  if (request.headers.get('range')) {
    event.respondWith(fetch(request).then(isolated).catch(() => Response.error()));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request).then(isolated));
    return;
  }

  event.respondWith(asset(request).then(isolated).catch(() => fetch(request).then(isolated)));
});
