// A small, faithful stand-in for the browser runtime's virtual filesystem so the
// real installer source can be executed under Node in tests.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { readSite, scriptById, pakoModule } from './embedded.mjs';

export function createVirtualFs() {
  // The runtime reassigns its module-level FS on transaction rollback, so the
  // harness keeps the current object in `state` and mirrors it on the sandbox.
  const state = { FS: Object.create(null) };
  const dirty = new Set();
  const FS = () => state.FS;

  const normalize = input => {
    const parts = [];
    for (const part of String(input).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return '/' + parts.join('/');
  };
  const dirname = input => {
    const value = normalize(input);
    const index = value.lastIndexOf('/');
    return index <= 0 ? '/' : value.slice(0, index);
  };
  const entry = file => FS()[normalize(file)];
  const mkdirp = dir => {
    const value = normalize(dir);
    if (value === '/') return;
    const parts = value.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      if (!FS()[current]) FS()[current] = { d: true, m: Date.now() };
    }
  };
  const writeFileSync = (file, data) => {
    const value = normalize(file);
    mkdirp(dirname(value));
    delete FS()[value];
    FS()[value] = { c: typeof data === 'string' ? data : Buffer.from(data), m: Date.now() };
    dirty.add(value);
  };
  const readFileSync = (file, encoding) => {
    const value = FS()[normalize(file)];
    if (!value || value.d) {
      const error = new Error('ENOENT: no such file or directory, open ' + file);
      error.code = 'ENOENT';
      throw error;
    }
    const content = value.c;
    if (encoding === 'utf8' || encoding === 'utf-8') return typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    return typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  };
  const existsSync = file => Boolean(FS()[normalize(file)]);
  const rmrf = file => {
    const value = normalize(file);
    for (const key of Object.keys(FS())) if (key === value || key.startsWith(value + '/')) delete FS()[key];
    for (const key of [...dirty]) if (key === value || key.startsWith(value + '/')) dirty.delete(key);
  };
  const readdir = dir => {
    const value = normalize(dir);
    const names = new Set();
    for (const key of Object.keys(FS())) {
      if (!key.startsWith(value === '/' ? '/' : value + '/')) continue;
      const rest = key.slice(value === '/' ? 1 : value.length + 1);
      if (rest) names.add(rest.split('/')[0]);
    }
    return [...names];
  };

  return { state, dirty, normalize, dirname, mkdirp, writeFileSync, readFileSync, existsSync, rmrf, readdir, entry };
}

const REGISTRY_CONSTANT = /const REG = 'https:\/\/registry\.npmjs\.org';/;

export function installerSource({ registry = 'https://registry.npmjs.org' } = {}) {
  const html = readSite();
  const runtime = scriptById(html, 'runtimeSource');
  const start = runtime.indexOf('/* Registry-only, integrity-checked, streamed package installation.');
  const end = runtime.indexOf('function staticResponse(urlPath){', start);
  if (start < 0 || end < 0) throw new Error('Installer block not found in the runtime source');
  let source = runtime.slice(start, end);
  if (registry !== 'https://registry.npmjs.org') {
    if (!REGISTRY_CONSTANT.test(source)) throw new Error('Registry constant not found');
    source = source.replace(REGISTRY_CONSTANT, `const REG = ${JSON.stringify(registry)};`);
  }
  return { source, kit: scriptById(html, 'runtimeSource'), html };
}

/** Builds a sandbox that can execute the real installer code. */
export function createInstallerSandbox(options = {}) {
  const vfs = createVirtualFs();
  const output = [];
  const posts = [];
  const transferred = [];
  const self = {
    BeownirInstallKit: loadKit(),
    postMessage: (message, transfer) => { posts.push(message); if (transfer) transferred.push(...transfer); }
  };
  const semver = loadSemver();
  const sandbox = {
    normalize: vfs.normalize,
    dirname: vfs.dirname,
    mkdirp: vfs.mkdirp,
    writeFileSync: vfs.writeFileSync,
    readFileSync: vfs.readFileSync,
    existsSync: vfs.existsSync,
    rmrf: vfs.rmrf,
    readdir: vfs.readdir,
    readdirSync: vfs.readdir,
    self,
    console,
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    fetch: (url, init) => fetch(url, init),
    AbortController,
    setTimeout,
    clearTimeout,
    performance,
    crypto,
    headSeen: undefined,
    td: new TextDecoder(),
    te: new TextEncoder(),
    browserSubtle: crypto.subtle,
    pakoApi: () => pakoModule(),
    BeownirSemver: semver,
    dirty: vfs.dirty,
    holdSync: 0,
    out: text => output.push(text),
    post: message => posts.push(message),
    syncBack: () => {},
    bundleBytes: 0,
    options
  };
  Object.defineProperty(sandbox, 'FS', {
    configurable: true,
    enumerable: true,
    get: () => vfs.state.FS,
    set: value => { vfs.state.FS = value; }
  });
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self.BeownirInstallKit = loadKit();
  return { sandbox, vfs, output, posts, self, transferred };
}

let cachedKit;
function loadKit() {
  if (!cachedKit) {
    const file = new URL('../../o/runtime/stream-kit.js', import.meta.url);
    const source = fs.readFileSync(file, 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, Uint8Array, TextDecoder, TextEncoder, fetch, AbortController, setTimeout, clearTimeout, URL, console }, { filename: 'stream-kit.js' });
    cachedKit = module.exports;
  }
  return cachedKit;
}

let cachedSemver;
function loadSemver() {
  if (cachedSemver) return cachedSemver;
  const runtime = scriptById(readSite(), 'runtimeSource');
  const start = runtime.indexOf('var BeownirSemver=');
  // Take only the semver IIFE by balancing braces, so unrelated runtime code is not evaluated.
  let index = runtime.indexOf('{', start), depth = 0, end = index;
  for (; index < runtime.length; index++) {
    if (runtime[index] === '{') depth++;
    else if (runtime[index] === '}') { depth--; if (depth === 0) { end = runtime.indexOf(';', index) + 1; break; } }
  }
  const source = runtime.slice(start, end);
  const sandbox = { TextEncoder, TextDecoder, Uint8Array, BigInt, Number, Object, Array, String, Math, JSON, RegExp, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, Infinity, NaN, console, crypto, performance, setTimeout, clearTimeout, queueMicrotask, URL, Buffer };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source + '\n;globalThis.__semver = BeownirSemver;', sandbox);
  cachedSemver = sandbox.__semver;
  return cachedSemver;
}

/** Evaluates the installer inside the sandbox and returns its entry points. */
export function loadInstaller(sandbox, source) {
  const names = ['npmInstall', 'npmCi', 'installPkg', 'extractPackage', 'fetchMeta', 'pickVersion', 'collectLock', 'INSTALL_BUDGET', 'writeBnpkToVfs', 'resolveInstallPlan', 'linkPackageBins'];
  const factory = new Function('__sandbox__', 'with (__sandbox__) {\n' + source + '\n;return {' + names.join(',') + '};}');
  return factory(sandbox);
}

export { path };
