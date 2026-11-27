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
const PREVIEW_TIMEOUT_MS = 600000;
const swCookieJars = new Map();
function swPortJar(port) {
  let jar = swCookieJars.get(port);
  if (!jar) { jar = new Map(); swCookieJars.set(port, jar); }
  return jar;
}
function swParseCookie(raw, reqPath) {
  const str = String(raw || '');
  const semi = str.indexOf(';');
  const first = (semi < 0 ? str : str.slice(0, semi)).trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let path = '/';
  if (reqPath && reqPath.startsWith('/')) {
    const slash = reqPath.lastIndexOf('/');
    path = slash > 0 ? reqPath.slice(0, slash) : '/';
  }
  let maxAge = null, expiresAt = null, httpOnly = false;
  if (semi >= 0) {
    for (const part of str.slice(semi + 1).split(';')) {
      const p = part.trim();
      if (!p) continue;
      const idx = p.indexOf('=');
      const k = (idx < 0 ? p : p.slice(0, idx)).trim().toLowerCase();
      const v = idx < 0 ? '' : p.slice(idx + 1).trim();
      if (k === 'path' && v.startsWith('/')) path = v;
      else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      else if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expiresAt = t; }
      else if (k === 'httponly') httpOnly = true;
    }
  }
  const exp = maxAge !== null ? (maxAge <= 0 ? 0 : Date.now() + maxAge * 1000) : expiresAt;
  return { name, value, path, expiresAt: exp, httpOnly };
}
function swSetCookies(port, setCookieHeader, reqPath) {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [String(setCookieHeader)] : [];
  const jar = swPortJar(port);
  for (const raw of list) {
    const parsed = swParseCookie(raw, reqPath);
    if (!parsed) continue;
    const key = parsed.name + '\0' + parsed.path;
    if (parsed.expiresAt !== null && parsed.expiresAt <= Date.now()) jar.delete(key);
    else jar.set(key, parsed);
  }
}
function swGetCookieHeader(port, reqPath) {
  const jar = swCookieJars.get(port);
  if (!jar || !jar.size) return '';
  const now = Date.now(), p = reqPath.split('?')[0] || '/';
  const out = [];
  for (const [key, item] of jar) {
    if (item.expiresAt !== null && item.expiresAt <= now) { jar.delete(key); continue; }
    if (item.path === '/' || p === item.path || p.startsWith(item.path.endsWith('/') ? item.path : item.path + '/')) {
      out.push(item.name + '=' + item.value);
    }
  }
  return out.join('; ');
}
function swSubdomainPort(hostname) {
  const match = /^p(\d{1,5})(?:-[a-z0-9-]+)?\./i.exec(String(hostname || ''));
  if (!match) return 0;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : 0;
}
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
  if (!previewPort) {
    var hm = /^p(\d{1,5})(?:-[a-z0-9-]+)?\./i.exec(window.location.hostname);
    if (hm) previewPort = Number(hm[1]) || 0;
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
    }, 60000);
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
  var INS_MAX = 200, insLogs = [], insErrs = [], insNet = [], insRefs = Object.create(null), insRefSeq = 0, insMutVer = 0, insLastMut = Date.now(), insObs = null;
  function insPush(arr, item) { if (arr.length >= INS_MAX) arr.shift(); arr.push(item); }
  function insFmt(v) { try { return typeof v === 'string' ? v : v instanceof Error ? (v.stack || v.message) : JSON.stringify(v); } catch (_) { return String(v); } }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lvl) {
    var orig = console[lvl].bind(console);
    console[lvl] = function () {
      var args = Array.prototype.slice.call(arguments, 0, 10);
      insPush(insLogs, { level: lvl, args: args.map(function (v) { return String(insFmt(v)).slice(0, 2000); }), timestamp: Date.now() });
      return orig.apply(console, arguments);
    };
  });
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      var m = (init && init.method) || (input && input.method) || 'GET';
      return origFetch(input, init).then(function (res) {
        if (res && res.status >= 400) insPush(insNet, { method: m, url: u, status: res.status, timestamp: Date.now() });
        return res;
      }, function (err) {
        insPush(insNet, { method: m, url: u, status: 0, error: String(err && err.message || err), timestamp: Date.now() });
        throw err;
      });
    };
  }
  window.addEventListener('error', function (ev) {
    insPush(insErrs, { type: 'error', message: String(ev.message || (ev.error && ev.error.message) || 'Script error'), stack: ev.error && ev.error.stack ? String(ev.error.stack) : undefined, url: ev.filename || '', line: ev.lineno || 0, column: ev.colno || 0, timestamp: Date.now() });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    insPush(insErrs, { type: 'rejection', message: String(ev.reason && ev.reason.message || ev.reason || 'Unhandled rejection'), stack: ev.reason && ev.reason.stack ? String(ev.reason.stack) : undefined, timestamp: Date.now() });
  });
  function insStartMut() {
    if (insObs || typeof MutationObserver !== 'function') return;
    var t = document.documentElement || document.body;
    if (!t) return;
    insObs = new MutationObserver(function () { insMutVer++; insLastMut = Date.now(); });
    try { insObs.observe(t, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', insStartMut, { once: true });
  else insStartMut();
  function insRect(el) {
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
  }
  function insVis(el) {
    if (!el || !el.isConnected) return false;
    var st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function insLabel(el) { return String(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.textContent || el.value || '').trim().slice(0, 160); }
  function insInteractive(limit) {
    var list = document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex]');
    return Array.prototype.slice.call(list, 0, Math.max(1, Math.min(200, Number(limit) || 100))).map(function (el) {
      var ref = el.getAttribute('data-beownir-ref');
      if (!ref) { ref = 'e' + (++insRefSeq); try { el.setAttribute('data-beownir-ref', ref); } catch (_) {} }
      insRefs[ref] = el;
      return { ref: ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'BUTTON' ? 'button' : el.tagName.toLowerCase()), name: insLabel(el), value: 'value' in el && el.type !== 'password' ? String(el.value || '').slice(0, 400) : undefined, disabled: Boolean(el.disabled), checked: 'checked' in el ? Boolean(el.checked) : undefined, visible: insVis(el), rect: insRect(el) };
    });
  }
  function insWait(cond, timeoutMs) {
    var deadline = Math.max(100, Number(timeoutMs) || 10000);
    if (!cond || cond === 'domcontentloaded') {
      if (document.readyState !== 'loading') return Promise.resolve({ readyState: document.readyState });
      return new Promise(function (resolve, reject) { var tm = setTimeout(function () { reject(new Error('Timed out waiting for domcontentloaded')); }, deadline); document.addEventListener('DOMContentLoaded', function () { clearTimeout(tm); resolve({ readyState: document.readyState }); }, { once: true }); });
    }
    if (cond === 'load') {
      if (document.readyState === 'complete') return Promise.resolve({ readyState: document.readyState });
      return new Promise(function (resolve, reject) { var tm = setTimeout(function () { reject(new Error('Timed out waiting for load')); }, deadline); window.addEventListener('load', function () { clearTimeout(tm); resolve({ readyState: document.readyState }); }, { once: true }); });
    }
    if (cond === 'settled') {
      insStartMut();
      return new Promise(function (resolve) { var s = Date.now(); function ck() { if (Date.now() - insLastMut >= 120 || Date.now() - s >= Math.min(deadline, 1500)) resolve({ mutationVersion: insMutVer, readyState: document.readyState }); else setTimeout(ck, 40); } setTimeout(ck, 60); });
    }
    if (typeof cond === 'object' && cond.selector) {
      var sel = String(cond.selector);
      if (document.querySelector(sel)) return Promise.resolve({ found: true, selector: sel });
      return new Promise(function (resolve, reject) { var s = Date.now(); function pl() { if (document.querySelector(sel)) { resolve({ found: true, selector: sel }); return; } if (Date.now() - s >= deadline) { reject(new Error('Timed out waiting for selector: ' + sel)); return; } setTimeout(pl, 40); } setTimeout(pl, 20); });
    }
    return Promise.resolve({ readyState: document.readyState });
  }
  function insMetrics() {
    var de = document.documentElement, b = document.body;
    var sw = Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0), sh = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0);
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    return { url: location.href, title: document.title || '', viewport: { width: vw, height: vh, scrollX: Math.round(window.scrollX || 0), scrollY: Math.round(window.scrollY || 0) }, documentSize: { width: sw, height: sh }, overflow: { horizontal: sw > vw, vertical: sh > vh }, mutationVersion: insMutVer };
  }
  function insDom(el, d, md, mc) {
    if (!el || d > md) return null;
    var n = { tag: el.tagName ? el.tagName.toLowerCase() : '#node', children: [] };
    if (el.id) n.id = el.id;
    if (typeof el.className === 'string' && el.className.trim()) n.class = el.className.trim().slice(0, 120);
    if (!el.children || !el.children.length) { var txt = String(el.textContent || '').trim(); if (txt) n.text = txt.slice(0, 200); }
    if (d < md && el.children) { for (var i = 0; i < Math.min(el.children.length, mc); i++) { var c = insDom(el.children[i], d + 1, md, mc); if (c) n.children.push(c); } }
    return n;
  }
  function insRun(op, p) {
    p = p || {};
    if (op === 'ping') return Promise.resolve({ ready: true, readyState: document.readyState, url: location.href, title: document.title || '', mutationVersion: insMutVer });
    if (op === 'waitUntil') return insWait(p.waitUntil || p.condition, p.timeout || p.timeoutMs);
    if (op === 'metrics') return Promise.resolve(insMetrics());
    if (op === 'text') { var r = p.selector ? document.querySelector(String(p.selector)) : (document.body || document.documentElement); var raw = r ? String(r.innerText !== undefined ? r.innerText : r.textContent || '') : ''; var ml = Math.max(100, Number(p.maxLength) || 16000); return Promise.resolve({ text: raw.slice(0, ml), length: raw.length, truncated: raw.length > ml }); }
    if (op === 'console') return Promise.resolve(p.clear ? insLogs.splice(0, insLogs.length) : insLogs.slice());
    if (op === 'errors') return Promise.resolve(p.clear ? insErrs.splice(0, insErrs.length) : insErrs.slice());
    if (op === 'networkFailures') return Promise.resolve(p.clear ? insNet.splice(0, insNet.length) : insNet.slice());
    if (op === 'interactive') return Promise.resolve(insInteractive(p.limit));
    if (op === 'dom') { var dr = p.selector ? document.querySelector(String(p.selector)) : (document.body || document.documentElement); return Promise.resolve(insDom(dr, 0, Math.max(1, Math.min(8, Number(p.maxDepth) || 4)), Math.max(1, Math.min(60, Number(p.maxChildren) || 30)))); }
    if (op === 'query') {
      var sel = String(p.selector || '*'), lim = Math.max(1, Math.min(100, Number(p.limit) || 25));
      return Promise.resolve(Array.prototype.slice.call(document.querySelectorAll(sel), 0, lim).map(function (el) {
        return { selector: sel, tag: el.tagName.toLowerCase(), id: el.id || '', className: typeof el.className === 'string' ? el.className : '', text: String(el.innerText !== undefined ? el.innerText : el.textContent || '').trim().slice(0, 500), rect: insRect(el), visible: insVis(el), attributes: {}, computed: {} };
      }));
    }
    if (op === 'act') {
      var el = p.ref ? insRefs[String(p.ref)] : (p.selector ? document.querySelector(String(p.selector)) : null);
      if (!el || !el.isConnected) return Promise.reject(new Error('Inspect target not found: ' + (p.ref || p.selector || 'missing')));
      if (el.disabled) return Promise.reject(new Error('Inspect target is disabled'));
      if (p.action === 'click') { if (el.focus) el.focus(); el.click(); }
      else if (p.action === 'fill' || p.action === 'select') { el.value = String(p.value || ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      else if (p.action === 'press') { var key = String(p.key || 'Enter'); el.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true, cancelable: true })); }
      else return Promise.reject(new Error('Unsupported inspect action: ' + p.action));
      return Promise.resolve({ ok: true, action: p.action, ref: p.ref || undefined, mutationVersion: insMutVer });
    }
    if (op === 'snapshot') {
      return Promise.resolve(p.waitUntil ? insWait(p.waitUntil, p.timeout || p.timeoutMs) : null).then(function () {
        var rt = p.selector ? document.querySelector(String(p.selector)) : (document.body || document.documentElement);
        var txt = rt ? String(rt.innerText !== undefined ? rt.innerText : rt.textContent || '').slice(0, 16000) : '';
        var m = insMetrics(); m.text = txt; m.console = insLogs.slice(); m.errors = insErrs.slice(); m.networkFailures = insNet.slice(); m.interactive = insInteractive(p.limit || 80); return m;
      });
    }
    return Promise.reject(new Error('Unsupported inspection operation: ' + op));
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.type !== 'beownir-inspect-request' || ev.source !== parent) return;
    var replyPort = ev.ports && ev.ports[0];
    Promise.resolve().then(function () { return insRun(d.op, d.params); }).then(function (data) {
      var res = { type: 'beownir-inspect-response', id: d.id, ok: true, data: data };
      if (replyPort) replyPort.postMessage(res); else parent.postMessage(res, '*');
    }, function (err) {
      var res = { type: 'beownir-inspect-response', id: d.id, ok: false, error: { message: String(err && err.message || err) } };
      if (replyPort) replyPort.postMessage(res); else parent.postMessage(res, '*');
    });
  });
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
  const reqHeaders = Object.fromEntries(request.headers);
  const jarCookies = swGetCookieHeader(port, path);
  if (jarCookies) reqHeaders.cookie = reqHeaders.cookie ? reqHeaders.cookie + '; ' + jarCookies : jarCookies;
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
    headers: reqHeaders, body,
  }, [channel.port2]);
  const result = await reply;
  const respHeaders = new Headers();
  if (result.headers && typeof result.headers === 'object') {
    for (const [k, v] of Object.entries(result.headers)) {
      if (k.toLowerCase() === 'set-cookie') {
        swSetCookies(port, v, path);
        continue;
      }
      if (Array.isArray(v)) for (const item of v) respHeaders.append(k, String(item));
      else if (v !== undefined && v !== null) respHeaders.set(k, String(v));
    }
  }
  const noBody = [101, 204, 205, 304].includes(result.status) || request.method === 'HEAD';
  return new Response(noBody ? null : result.body, {
    status: result.status, statusText: result.statusMessage || '', headers: respHeaders,
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
    const subPort = swSubdomainPort(url.hostname);
    if (subPort > 0 && url.pathname !== '/coi-sw.js') {
      const path = url.pathname + url.search;
      event.respondWith(previewResponse(request, subPort, path)
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
