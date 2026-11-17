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
 * MessageChannel; the tab routes it through the same kernel path the in-page preview uses. */
const PREVIEW_PREFIX = '/__beownir_preview__/';
const PREVIEW_TIMEOUT_MS = 20000;
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

async function previewResponse(request, url) {
  const route = previewRoute(url);
  if (!route) return textResponse('Not a preview address.', 404);
  const client = await kernelClient();
  if (!client) return textResponse('Open the Beownir IDE tab on this site to serve preview port ' + route.port + '.', 503);
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
    type: 'beownir-sw-http', port: route.port, url: route.path, method: request.method,
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

  if (url.origin === self.location.origin && url.pathname.startsWith(PREVIEW_PREFIX)) {
    event.respondWith(previewResponse(request, url).catch(error => textResponse('Preview failed: ' + error.message, 502)).then(isolated));
    return;
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
