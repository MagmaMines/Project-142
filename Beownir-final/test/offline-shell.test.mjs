import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root } from './helpers/embedded.mjs';

/* The service worker is the only part of the product that runs outside the
 * page, so it is exercised here with a fake Cache API and fetch. */

const source = fs.readFileSync(path.join(root, 'o', 'site', 'coi-sw.js'), 'utf8');

// Request cannot be constructed with mode 'navigate' (browsers and Node alike),
// so navigations are described with the fields the worker reads.
const navigation = url => ({ url, mode: 'navigate', headers: new Headers(), cache: 'default' });

function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async put(request, response) { entries.set(typeof request === 'string' ? request : request.url, response); },
    async add(request) { const url = typeof request === 'string' ? request : request.url; entries.set(url, new Response('shell:' + url)); },
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (entries.has(url)) return entries.get(url);
      for (const [key, value] of entries) if (url.endsWith(key)) return value;
      return undefined;
    },
    async keys() { return [...entries.keys()].map(url => new Request(url)); },
  };
}

function boot({ online = true, cache = fakeCache(), existingCaches = [] } = {}) {
  const listeners = new Map();
  const posted = [];
  const stores = new Map([[ 'beownir-shell-v3', cache ]]);
  for (const name of existingCaches) stores.set(name, fakeCache());
  const self = {
    location: { origin: 'https://ide.example.test' },
    addEventListener: (type, handler) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: { unregister: async () => { listeners.set('unregistered', []); } },
  };
  self.self = self;
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, fakeCache()); return stores.get(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) { for (const store of stores.values()) { const hit = await store.match(request); if (hit) return hit; } return undefined; },
  };
  const fetchCalls = [];
  const fetch = async request => {
    const url = typeof request === 'string' ? request : request.url;
    fetchCalls.push(url);
    if (!online) throw new Error('offline');
    return new Response('network:' + url, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const sandbox = { self, caches, fetch, Request, Response, Headers, URL, console, location: self.location };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'coi-sw.js' });
  const dispatch = async (type, event) => {
    const waits = [];
    event.waitUntil = promise => waits.push(promise);
    event.respondWith = promise => { event.response = promise; };
    for (const handler of listeners.get(type) || []) handler(event);
    await Promise.all(waits);
    return event;
  };
  return { listeners, self, caches, stores, posted, fetchCalls, dispatch, cache };
}

test('the worker parses and registers both jobs', () => {
  assert.doesNotThrow(() => new vm.Script(source));
  const worker = boot();
  assert.ok(worker.listeners.has('install'), 'install listener');
  assert.ok(worker.listeners.has('activate'), 'activate listener');
  assert.ok(worker.listeners.has('fetch'), 'fetch listener');
  assert.ok(worker.listeners.has('message'), 'message listener');
  assert.match(source, /Cross-Origin-Embedder-Policy/);
  assert.match(source, /beownir-shell-v3/);
});

test('install precaches the shell and drops stale cache versions', async () => {
  const worker = boot({ existingCaches: ['beownir-shell-v2'] });
  await worker.dispatch('install', {});
  const cache = worker.stores.get('beownir-shell-v3');
  const urls = [...cache.entries.keys()];
  assert.ok(urls.some(url => url.endsWith('/') || url.endsWith('/index.html')), 'the shell is cached');
  assert.equal(worker.stores.has('beownir-shell-v2'), false, 'old shells are removed');
});

test('a navigation boots from cache when the network is down', async () => {
  const worker = boot();
  await worker.dispatch('install', {});
  worker.self.location.origin = 'https://ide.example.test';
  const offline = boot({ online: false, cache: worker.stores.get('beownir-shell-v3') });
  await offline.dispatch('install', {});
  const event = await offline.dispatch('fetch', { request: navigation('https://ide.example.test/') });
  const response = await event.response;
  assert.ok(response, 'a response is produced offline');
  assert.match(await response.text(), /shell:/);
});

test('navigation prefers the network and refreshes the cache when online', async () => {
  const worker = boot();
  const event = await worker.dispatch('fetch', { request: navigation('https://ide.example.test/') });
  const response = await event.response;
  assert.match(await response.text(), /network:/);
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
});

test('cross-origin and range requests are never cached', async () => {
  const worker = boot();
  await worker.dispatch('fetch', { request: new Request('https://registry.npmjs.org/next') });
  await worker.dispatch('fetch', { request: new Request('https://ide.example.test/shell.js', { headers: { range: 'bytes=0-1023' } }) });
  const cache = worker.stores.get('beownir-shell-v3');
  assert.equal(cache.entries.size, 0, 'nothing was written to the shell cache');
  assert.ok(worker.fetchCalls.some(url => url.includes('registry.npmjs.org')));
});

test('message commands report and clear the shell cache', async () => {
  const worker = boot();
  await worker.dispatch('install', {});
  const replies = [];
  const source_ = { postMessage: message => replies.push(message) };
  await worker.dispatch('message', { data: { type: 'status' }, source: source_ });
  assert.equal(replies[0].type, 'shell-status');
  assert.ok(replies[0].cached >= 1);
  assert.equal(replies[0].version, 'beownir-shell-v3');
  await worker.dispatch('message', { data: { type: 'clear-cache' }, source: source_ });
  assert.equal(replies.at(-1).type, 'shell-cleared');
  await worker.dispatch('message', { data: { type: 'skip-waiting' } });
  await worker.dispatch('message', { data: { type: 'deregister' } });
});
