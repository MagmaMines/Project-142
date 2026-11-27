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
  // keeps the browser's own WebSocket. Vite's HMR client connects this way. Loopback names all
  // point at the same in-process virtual servers, so all of them are virtualized.
  const NativeWebSocket = window.WebSocket;
  const sockets = new Map();
  let socketSequence = 0;
  const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
  function virtualSocketTarget(url) {
    try {
      const target = new URL(String(url), base);
      if (!LOOPBACK_NAMES.has(target.hostname) || (target.protocol !== 'ws:' && target.protocol !== 'wss:')) return null;
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
      this._sendQueue = Promise.resolve();
      this._queued = 0;
      sockets.set(this.id, this);
      send({ type: 'ws', op: 'open', id: this.id, port: target.port, url: target.path, protocols: protocols ? [].concat(protocols).map(String) : [] })
        .catch(error => dispatchWsEvent({ id: this.id, event: 'error', message: error.message }));
    }
    _enqueue(fn) {
      this._queued++;
      this._sendQueue = this._sendQueue.then(fn, fn).finally(() => {
        this._queued = Math.max(0, this._queued - 1);
      });
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open yet', 'InvalidStateError');
      if (typeof data === 'string') {
        const dispatch = () => send({ type: 'ws', op: 'send', id: this.id, data, binary: false }).catch(() => {});
        if (this._queued === 0) dispatch();
        else this._enqueue(dispatch);
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        this._enqueue(async () => {
          const buffer = await data.arrayBuffer();
          if (this.readyState <= 2) {
            await send({ type: 'ws', op: 'send', id: this.id, data: new Uint8Array(buffer), binary: true }).catch(() => {});
          }
        });
        return;
      }
      let payload, binary = false;
      if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) {
        payload = new Uint8Array(data).slice();
        binary = true;
      } else if (ArrayBuffer.isView(data)) {
        payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        binary = true;
      } else {
        payload = String(data);
      }
      const dispatch = () => send({ type: 'ws', op: 'send', id: this.id, data: payload, binary }).catch(() => {});
      if (this._queued === 0) dispatch();
      else this._enqueue(dispatch);
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      const finishClose = () => send({ type: 'ws', op: 'close', id: this.id, code, reason }).catch(() => {});
      if (this._queued === 0) finishClose();
      else this._enqueue(finishClose);
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

  /* ES modules in the preview. `<script type="module">` cannot reach the virtual
   * dev server on its own (the document URL is not the virtual origin), so every
   * module — the initial page and Vite's HMR re-imports — is loaded here:
   * fetch the transformed source through the virtual server, rewrite every
   * static import to an inline data: module, and hand back a namespace.
   * External origins are never fetched; they fail through the normal CSP. */
  const moduleCache = new Map();
  let totalModuleBytes = 0;
  const MODULE_BYTES_LIMIT = 8 * 1024 * 1024;
  const TOTAL_MODULE_BYTES_LIMIT = 48 * 1024 * 1024;
  const DEPTH_LIMIT = 16;
  const toBase64 = text => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
    return btoa(binary);
  };
  const moduleKey = url => url.pathname + url.search;
  function fetchModule(url) {
    return window.fetch(moduleKey(url)).then(response => {
      if (!response.ok) {
        return response.text().then(text => { throw new Error('Module request failed (HTTP ' + response.status + '): ' + moduleKey(url) + (text ? '\n' + String(text).slice(0, 2000) : '')); });
      }
      return response.text();
    });
  }
  function decodeStringLiteral(raw) {
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') < 0) return inner;
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch !== '\\') { out += ch; continue; }
      const next = inner[++i];
      if (next === undefined) break;
      if (next === '\n') continue;
      if (next === '\r') { if (inner[i + 1] === '\n') i++; continue; }
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === 'v') out += '\v';
      else if (next === '0' && !/[0-9]/.test(inner[i + 1] || '')) out += '\0';
      else if (next === 'x' && /^[0-9a-fA-F]{2}/.test(inner.slice(i + 1, i + 3))) {
        out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (next === 'u') {
        if (inner[i + 1] === '{') {
          const close = inner.indexOf('}', i + 2);
          if (close > i + 2 && /^[0-9a-fA-F]+$/.test(inner.slice(i + 2, close))) {
            out += String.fromCodePoint(parseInt(inner.slice(i + 2, close), 16));
            i = close;
            continue;
          }
        } else if (/^[0-9a-fA-F]{4}/.test(inner.slice(i + 1, i + 5))) {
          out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
          i += 4;
          continue;
        }
        out += next;
      } else out += next;
    }
    return out;
  }
  const REGEX_BEFORE_KEYWORDS = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'await', 'yield', 'in', 'instanceof', 'new', 'else', 'do', 'of', 'export', 'default', 'import']);
  const isIdentStart = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
  const isIdentPart = c => isIdentStart(c) || (c >= 48 && c <= 57);
  const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || c === 0xfeff;
  function skipString(code, start) {
    const quote = code.charCodeAt(start);
    let i = start + 1;
    while (i < code.length) {
      const c = code.charCodeAt(i);
      if (c === 92) {
        if (code.charCodeAt(i + 1) === 13 && code.charCodeAt(i + 2) === 10) i += 3;
        else i += 2;
        continue;
      }
      if (c === quote) return i + 1;
      if (c === 10 || c === 13) return i;
      i++;
    }
    return code.length;
  }
  function skipTemplateChunk(code, start) {
    let i = start;
    while (i < code.length) {
      const c = code.charCodeAt(i);
      if (c === 92) { i += 2; continue; }
      if (c === 96) return { kind: 'end', end: i + 1 };
      if (c === 36 && code.charCodeAt(i + 1) === 123) return { kind: 'expr', end: i + 2 };
      i++;
    }
    return { kind: 'end', end: code.length };
  }
  function scanRegexEnd(code, start) {
    let i = start + 1, inClass = false;
    while (i < code.length) {
      const c = code.charCodeAt(i);
      if (c === 92) {
        const next = code.charCodeAt(i + 1);
        if (Number.isNaN(next) || next === 10 || next === 13 || next === 0x2028 || next === 0x2029) return -1;
        i += 2; continue;
      }
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return -1;
      if (c === 91) { inClass = true; i++; continue; }
      if (c === 93) { inClass = false; i++; continue; }
      if (c === 47 && !inClass) {
        i++;
        while (i < code.length && ((code.charCodeAt(i) >= 65 && code.charCodeAt(i) <= 90) || (code.charCodeAt(i) >= 97 && code.charCodeAt(i) <= 122))) i++;
        return i;
      }
      i++;
    }
    return -1;
  }
  function skipTrivia(code, pos) {
    let i = pos;
    while (i < code.length) {
      const c = code.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (c === 47 && code.charCodeAt(i + 1) === 47) {
        i += 2;
        while (i < code.length && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i++;
        continue;
      }
      if (c === 47 && code.charCodeAt(i + 1) === 42) {
        const close = code.indexOf('*/', i + 2);
        i = close < 0 ? code.length : close + 2;
        continue;
      }
      break;
    }
    return i;
  }
  function isImportMethodDef(code, openParenIndex) {
    let i = openParenIndex + 1, parenDepth = 1;
    const tStack = [];
    while (i < code.length && parenDepth > 0) {
      const c = code.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (c === 47 && code.charCodeAt(i + 1) === 47) {
        i += 2;
        while (i < code.length && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i++;
        continue;
      }
      if (c === 47 && code.charCodeAt(i + 1) === 42) {
        const close = code.indexOf('*/', i + 2);
        i = close < 0 ? code.length : close + 2;
        continue;
      }
      if (c === 34 || c === 39) { i = skipString(code, i); continue; }
      if (c === 96) {
        const chunk = skipTemplateChunk(code, i + 1);
        i = chunk.end;
        if (chunk.kind === 'expr') tStack.push(0);
        continue;
      }
      if (tStack.length) {
        if (c === 123) { tStack[tStack.length - 1]++; i++; continue; }
        if (c === 125) {
          if (--tStack[tStack.length - 1] < 0) {
            tStack.pop();
            const chunk = skipTemplateChunk(code, i + 1);
            i = chunk.end;
            if (chunk.kind === 'expr') tStack.push(0);
            continue;
          }
          i++; continue;
        }
      }
      if (c === 40) parenDepth++;
      else if (c === 41) parenDepth--;
      i++;
    }
    if (parenDepth !== 0) return false;
    const after = skipTrivia(code, i);
    return code.charCodeAt(after) === 123; // `{` follows `(params)` -> method definition, not `import(...)`
  }
  function scanModuleImports(code) {
    const ops = [];
    const templateBraces = [];
    let i = 0, regexAllowed = true, prevDot = false, pending = null;
    while (i < code.length) {
      const c = code.charCodeAt(i);
      if (isSpace(c)) { i++; continue; }
      if (c === 47) {
        const next = code.charCodeAt(i + 1);
        if (next === 47) {
          i += 2;
          while (i < code.length && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i++;
          continue;
        }
        if (next === 42) {
          const close = code.indexOf('*/', i + 2);
          i = close < 0 ? code.length : close + 2;
          continue;
        }
        if (regexAllowed) {
          const reEnd = scanRegexEnd(code, i);
          if (reEnd > i) {
            pending = null; prevDot = false; regexAllowed = false;
            i = reEnd; continue;
          }
        }
        pending = null; prevDot = false; regexAllowed = true;
        i += next === 61 ? 2 : 1; continue;
      }
      if (c === 34 || c === 39) {
        const end = skipString(code, i);
        if (pending && (pending.kind === 'from' || pending.kind === 'import')) {
          ops.push({ kind: 'static', start: i, end, spec: decodeStringLiteral(code.slice(i, end)) });
        }
        pending = null; prevDot = false; regexAllowed = false;
        i = end; continue;
      }
      if (c === 96) {
        pending = null; prevDot = false; regexAllowed = false;
        const chunk = skipTemplateChunk(code, i + 1);
        i = chunk.end;
        if (chunk.kind === 'expr') { templateBraces.push(0); regexAllowed = true; }
        continue;
      }
      if (templateBraces.length) {
        if (c === 123) {
          templateBraces[templateBraces.length - 1]++;
          pending = null; prevDot = false; regexAllowed = true;
          i++; continue;
        }
        if (c === 125) {
          if (--templateBraces[templateBraces.length - 1] < 0) {
            templateBraces.pop();
            pending = null; prevDot = false;
            const chunk = skipTemplateChunk(code, i + 1);
            i = chunk.end;
            if (chunk.kind === 'expr') { templateBraces.push(0); regexAllowed = true; }
            else regexAllowed = false;
            continue;
          }
          pending = null; prevDot = false; regexAllowed = true;
          i++; continue;
        }
      }
      if (isIdentStart(c)) {
        const start = i;
        i++;
        while (i < code.length && isIdentPart(code.charCodeAt(i))) i++;
        const word = code.slice(start, i);
        pending = !prevDot && (word === 'import' || word === 'from') ? { kind: word, start, end: i } : null;
        prevDot = false;
        regexAllowed = REGEX_BEFORE_KEYWORDS.has(word);
        continue;
      }
      if ((c >= 48 && c <= 57) || (c === 46 && code.charCodeAt(i + 1) >= 48 && code.charCodeAt(i + 1) <= 57)) {
        pending = null; prevDot = false; regexAllowed = false;
        if (c === 48 && (code.charCodeAt(i + 1) === 120 || code.charCodeAt(i + 1) === 88 || code.charCodeAt(i + 1) === 98 || code.charCodeAt(i + 1) === 66 || code.charCodeAt(i + 1) === 111 || code.charCodeAt(i + 1) === 79)) {
          i += 2;
          while (i < code.length && /[0-9a-fA-F_]/.test(code[i])) i++;
        } else {
          while (i < code.length && /[0-9_]/.test(code[i])) i++;
          if (code.charCodeAt(i) === 46) { i++; while (i < code.length && /[0-9_]/.test(code[i])) i++; }
          if (code.charCodeAt(i) === 101 || code.charCodeAt(i) === 69) {
            i++;
            if (code.charCodeAt(i) === 43 || code.charCodeAt(i) === 45) i++;
            while (i < code.length && /[0-9_]/.test(code[i])) i++;
          }
        }
        if (code.charCodeAt(i) === 110) i++;
        continue;
      }
      if (c === 40) {
        if (pending && pending.kind === 'import' && !isImportMethodDef(code, i)) {
          ops.push({ kind: 'dynamic', start: pending.start, end: pending.end });
        }
        pending = null; prevDot = false; regexAllowed = true;
        i++; continue;
      }
      if (c === 46) {
        pending = null;
        if (code.charCodeAt(i + 1) === 46 && code.charCodeAt(i + 2) === 46) { prevDot = false; regexAllowed = true; i += 3; continue; }
        prevDot = true; regexAllowed = false; i++; continue;
      }
      if (c === 63 && code.charCodeAt(i + 1) === 46 && !(code.charCodeAt(i + 2) >= 48 && code.charCodeAt(i + 2) <= 57)) {
        pending = null; prevDot = true; regexAllowed = false; i += 2; continue;
      }
      if ((c === 43 && code.charCodeAt(i + 1) === 43) || (c === 45 && code.charCodeAt(i + 1) === 45)) {
        pending = null; prevDot = false; regexAllowed = false; i += 2; continue;
      }
      pending = null; prevDot = false;
      regexAllowed = !(c === 41 || c === 93);
      i++;
    }
    return ops;
  }
  async function resolveSpecifier(spec, importer, depth, seen) {
    if (/^(data:|blob:)/i.test(spec)) return spec;
    const resolved = new URL(spec, importer);
    if (/^https?:$/i.test(resolved.protocol) && resolved.origin !== virtualOrigin) return spec; // external: leave, CSP will refuse it
    const key = moduleKey(resolved);
    if (seen.has(key)) {
      console.warn('[preview] circular module import stubbed: ' + key);
      return 'data:text/javascript;base64,' + toBase64('export {}');
    }
    return loadModule(resolved, depth + 1, seen);
  }
  async function rewriteModule(code, importer, depth, seen) {
    if (depth > DEPTH_LIMIT) throw new Error('Module graph nesting limit reached at ' + importer);
    const next = new Set(seen || []);
    next.add(moduleKey(new URL(importer)));
    const ops = scanModuleImports(code);
    const staticOps = ops.filter(op => op.kind === 'static');
    const results = await Promise.all(staticOps.map(op => resolveSpecifier(op.spec, importer, depth, next)));
    let staticIdx = 0;
    const pieces = [];
    let lastIndex = 0;
    for (const op of ops) {
      pieces.push(code.slice(lastIndex, op.start));
      if (op.kind === 'static') pieces.push(JSON.stringify(results[staticIdx++]));
      else pieces.push('globalThis.__beownirDynamicImport');
      lastIndex = op.end;
    }
    pieces.push(code.slice(lastIndex));
    return pieces.join('');
  }
  function loadModule(url, depth, seen) {
    const key = moduleKey(url);
    let entry = moduleCache.get(key);
    if (!entry) {
      entry = (async () => {
        const code = await fetchModule(url);
        totalModuleBytes += code.length;
        if (code.length > MODULE_BYTES_LIMIT) throw new Error('Module exceeds the 8 MiB budget: ' + key);
        if (totalModuleBytes > TOTAL_MODULE_BYTES_LIMIT) throw new Error('Module graph exceeds the 48 MiB session budget (last: ' + key + ')');
        const rewritten = await rewriteModule(code, url.href, depth, seen || new Set([key]));
        return 'data:text/javascript;base64,' + toBase64(rewritten);
      })();
      moduleCache.set(key, entry);
      entry.catch(() => moduleCache.delete(key));
    }
    return entry;
  }
  const loadModuleUrl = typeof config.importDataUrl === 'function' ? config.importDataUrl : url => import(url);
  window.__beownirDynamicImport = async spec => {
    const text = String(spec);
    if (/^data:/i.test(text)) return loadModuleUrl(text);
    const url = new URL(text, virtualOrigin + '/');
    if (/^https?:$/i.test(url.protocol) && url.origin !== virtualOrigin) throw new TypeError('External module imports are disabled in the preview: ' + text);
    const dataUrl = await loadModule(url, 0, new Set([moduleKey(url)]));
    return loadModuleUrl(dataUrl);
  };
})();
