(() => {
  'use strict';
  const config = window.__BEOWNIR_PREVIEW_CONFIG__;
  if (!config) return;
  const virtualOrigin = 'http://localhost:' + config.port;
  const base = new URL(config.path, virtualOrigin);
  let port, sequence = 0;
  const waiting = new Map();
  const connected = new Promise(resolve => {
    window.addEventListener('message', function connect(event) {
      if (event.source !== parent || event.data?.type !== 'beownir-preview' || event.data.token !== config.token || !event.ports[0]) return;
      port = event.ports[0]; window.removeEventListener('message', connect);
      port.onmessage = event => {
        if (event.data?.type === 'wsevent') { dispatchWsEvent(event.data); return; }
        const message = event.data, request = waiting.get(message?.id);
        if (!request) return;
        waiting.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message);
      };
      port.start(); resolve(port);
    });
  });
  async function send(message) {
    const channel = await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('Preview bridge did not connect.')), 8000))]);
    channel.postMessage(message);
  }
  window.fetch = async function virtualFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, base);
    if (url.origin !== virtualOrigin) throw new TypeError('External preview requests are disabled. Use a backend or a browser-compatible API integration outside single-file mode.');
    const request = new Request(url.href, { ...(input instanceof Request ? { method: input.method, headers: input.headers, body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.clone().arrayBuffer() } : {}), ...init });
    if (request.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
    if (body && body.byteLength > 1024 * 1024) throw new Error('Virtual request body exceeds 1 MiB.');
    const id = ++sequence;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Virtual request timed out.')); }, 15000);
      waiting.set(id, { resolve, reject, timer });
      request.signal.addEventListener('abort', () => { const item = waiting.get(id); if (item) { clearTimeout(item.timer); waiting.delete(id); reject(new DOMException('Request aborted', 'AbortError')); } }, { once: true });
      send({ type: 'request', id, path: url.pathname + url.search, method: request.method, headers: Object.fromEntries(request.headers), body }).catch(error => { clearTimeout(timer); waiting.delete(id); reject(error); });
    });
    const noBody = [101, 204, 205, 304].includes(response.status) || request.method === 'HEAD';
    return new Response(noBody ? null : response.body, { status: response.status, headers: response.headers });
  };
  function safeFormat(value) { try { return typeof value === 'string' ? value : value instanceof Error ? value.stack || value.message : JSON.stringify(value); } catch { return String(value); } }
  let logCount = 0;
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[name].bind(console);
    console[name] = (...args) => { original(...args); if (++logCount < 2000) send({ type: 'console', level: name, args: args.slice(0, 10).map(v => String(safeFormat(v)).slice(0, 2000)) }).catch(() => {}); };
  }
  /* Live reload: the IDE captures the scroll offset and typed form values
   * before a refresh and restores them once the new document is ready, so a
   * save looks like a hot update instead of a restart. */
  function controlKey(node, index) { return node.id || node.name || (node.form && node.form.id ? node.form.id + ':' : '') + index; }
  function controlNodes() { return Array.from(document.querySelectorAll('input,textarea,select')); }
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'beownir-preview-capture') {
      const state = { scroll: [Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)], fields: [], focus: null };
      controlNodes().forEach((node, index) => {
        if (node.type === 'password' || node.type === 'file') return;
        const key = controlKey(node, index);
        if (node instanceof HTMLInputElement && (node.type === 'checkbox' || node.type === 'radio')) state.fields.push({ key, checked: Boolean(node.checked) });
        else state.fields.push({ key, value: String(node.value ?? '').slice(0, 4096) });
        if (node === document.activeElement) state.focus = { key, start: typeof node.selectionStart === 'number' ? node.selectionStart : null, end: typeof node.selectionEnd === 'number' ? node.selectionEnd : null };
      });
      try { parent.postMessage({ type: 'beownir-preview-state', id: data.id, state }, '*'); } catch { /* detached frame */ }
      return;
    }
    if (data.type === 'beownir-preview-restore' && data.state) {
      const state = data.state;
      const apply = () => {
        if (Array.isArray(state.scroll)) { try { window.scrollTo(state.scroll[0] || 0, state.scroll[1] || 0); } catch { /* ignore */ } }
        controlNodes().forEach((node, index) => {
          const key = controlKey(node, index);
          const saved = (state.fields || []).find(item => item.key === key);
          if (!saved) return;
          try {
            if ('checked' in saved) node.checked = saved.checked;
            else if (!(node instanceof HTMLInputElement && node.type === 'file')) node.value = saved.value;
          } catch { /* read-only control */ }
        });
        if (state.focus) {
          const target = controlNodes().find((node, index) => controlKey(node, index) === state.focus.key);
          if (target) {
            try {
              target.focus({ preventScroll: true });
              if (state.focus.start !== null && typeof target.setSelectionRange === 'function') target.setSelectionRange(state.focus.start, state.focus.end ?? state.focus.start);
            } catch { /* selection is not always supported */ }
          }
        }
      };
      apply();
      if (document.readyState !== 'complete') window.addEventListener('load', apply, { once: true });
    }
  });
  window.addEventListener('error', event => console.error(event.error?.stack || event.message));
  window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack || event.reason));
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]'); if (!link) return;
    if (link.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    try {
      const url = new URL(link.getAttribute('href'), base);
      if (url.origin !== virtualOrigin) return console.warn('External navigation blocked in preview.');
      send({ type: 'navigate', path: url.pathname + url.search }).catch(error => console.error(error));
    } catch (error) { console.error(error); }
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target; event.preventDefault();
    try {
      const url = new URL(form.getAttribute('action') || base.href, base), method = (form.method || 'GET').toUpperCase();
      if (url.origin !== virtualOrigin) throw new Error('External form submissions are disabled.');
      const data = new URLSearchParams(); for (const [key, value] of new FormData(form)) data.append(key, typeof value === 'string' ? value : value.name);
      if (method === 'GET') url.search = data.toString();
      send({ type: 'navigate', path: url.pathname + url.search, method, body: method === 'GET' ? null : data.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(error => console.error(error));
    } catch (error) { console.error(error); }
  }, true);
  class VirtualXHR extends EventTarget {
    constructor() { super(); this.readyState = 0; this.status = 0; this.responseType = ''; this.response = null; this.responseText = ''; this.timeout = 0; this.withCredentials = false; this._headers = {}; this._controller = new AbortController(); }
    _event(name) { const event = new Event(name); this.dispatchEvent(event); this['on' + name]?.(event); }
    open(method, path, async = true) { if (!async) throw new Error('Synchronous XMLHttpRequest is unsupported.'); this._method = method; this._path = path; this.readyState = 1; this._event('readystatechange'); }
    setRequestHeader(name, value) { this._headers[name] = value; }
    getResponseHeader(name) { return this._responseHeaders?.get(name) || null; }
    getAllResponseHeaders() { return this._responseHeaders ? [...this._responseHeaders].map(([k, v]) => k + ': ' + v).join('\r\n') : ''; }
    abort() { this._controller.abort(); }
    async send(body = null) {
      let timer;
      try {
        if (this.timeout) timer = setTimeout(() => this._controller.abort(), this.timeout);
        const response = await window.fetch(this._path, { method: this._method, headers: this._headers, body: ['GET', 'HEAD'].includes(this._method.toUpperCase()) ? undefined : body, signal: this._controller.signal });
        this.status = response.status; this._responseHeaders = response.headers; this.readyState = 2; this._event('readystatechange');
        const bytes = await response.arrayBuffer(); this.responseText = new TextDecoder().decode(bytes);
        this.response = this.responseType === 'arraybuffer' ? bytes : this.responseType === 'blob' ? new Blob([bytes], { type: response.headers.get('content-type') || '' }) : this.responseType === 'json' ? JSON.parse(this.responseText) : this.responseText;
        this.readyState = 4; this._event('readystatechange'); this._event('load');
      } catch (error) { this.readyState = 4; this._event(error.name === 'AbortError' ? 'abort' : 'error'); }
      finally { clearTimeout(timer); this._event('loadend'); }
    }
  }
  window.XMLHttpRequest = VirtualXHR;
  // WebSocket to a virtual port (ws://localhost:<port>) goes through the runtime; every other URL
  // keeps the browser's own WebSocket. Vite's HMR client connects this way.
  const NativeWebSocket = window.WebSocket;
  const sockets = new Map();
  let socketSequence = 0;
  function virtualSocketTarget(url) {
    try {
      const target = new URL(String(url), base);
      if (target.hostname !== 'localhost' || (target.protocol !== 'ws:' && target.protocol !== 'wss:')) return null;
      return { port: Number(target.port) || (target.protocol === 'wss:' ? 443 : 80), path: target.pathname + target.search, href: target.href };
    } catch { return null; }
  }
  function dispatchWsEvent(message) {
    const socket = sockets.get(message.id);
    if (!socket) return;
    if (message.event === 'open') { socket.readyState = 1; socket.protocol = message.protocol || ''; socket._fire('open', {}); }
    else if (message.event === 'message') socket._fire('message', { data: message.binary ? (socket.binaryType === 'arraybuffer' ? new Uint8Array(message.data).buffer : new Blob([message.data])) : message.data });
    else if (message.event === 'error') socket._fire('error', { message: message.message || 'WebSocket error' });
    else if (message.event === 'close') { sockets.delete(socket.id); socket.readyState = 3; socket._fire('close', { code: message.code || 1006, reason: message.reason || '', wasClean: message.code === 1000 }); }
  }
  class VirtualWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const target = virtualSocketTarget(url);
      this.url = target.href; this.readyState = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob'; this.bufferedAmount = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.id = 'ws-' + (++socketSequence);
      sockets.set(this.id, this);
      send({ type: 'ws', op: 'open', id: this.id, port: target.port, url: target.path, protocols: protocols ? [].concat(protocols).map(String) : [] })
        .catch(error => dispatchWsEvent({ id: this.id, event: 'error', message: error.message }));
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open yet', 'InvalidStateError');
      const binary = typeof data !== 'string';
      const payload = !binary ? data : new Uint8Array(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      send({ type: 'ws', op: 'send', id: this.id, data: payload, binary }).catch(() => {});
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      send({ type: 'ws', op: 'close', id: this.id, code, reason }).catch(() => {});
    }
    _fire(type, init) {
      const event = type === 'message' ? new MessageEvent('message', init) : Object.assign(new Event(type), init);
      const handler = this['on' + type];
      if (typeof handler === 'function') handler.call(this, event);
      this.dispatchEvent(event);
    }
  }
  Object.assign(VirtualWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = function WebSocket(url, protocols) {
    if (!virtualSocketTarget(url)) return new NativeWebSocket(url, protocols);
    return new VirtualWebSocket(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();
