#!/usr/bin/env node
/**
 * Boots `beownir-standalone.html` on its own.
 *
 * The point of a single-file distribution is that it works without the source
 * tree, so this smoke test reads *only* the artifact: it verifies the manifest,
 * parses every embedded script block, boots the worker runtime inside a VM from
 * the embedded `runtimeSource` text, runs real commands through the terminal
 * path, checks the virtual filesystem persists across a "reload" and decodes
 * the embedded WASM assets. It does not import a single module from `o/`.
 *
 * Used by `node tools/build-standalone.mjs --smoke` and by
 * `test/standalone.test.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function scriptById(html, id) {
  const pattern = new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)</script>');
  const match = pattern.exec(html);
  if (!match) throw new Error('missing embedded script: ' + id);
  return match[1];
}

const MANIFEST_OPEN = '<script id="beownir-build-manifest" type="application/json">';
const MANIFEST_CLOSE = '</script>';

export function readManifest(html) {
  const open = html.indexOf(MANIFEST_OPEN);
  if (open < 0) return null;
  const start = open + MANIFEST_OPEN.length;
  const end = html.indexOf(MANIFEST_CLOSE, start);
  if (end < 0) return null;
  return JSON.parse(html.slice(start, end));
}

/** The document with an empty manifest block, which is what the digest covers. */
export function withoutManifest(html) {
  const open = html.indexOf(MANIFEST_OPEN);
  if (open < 0) return html;
  const end = html.indexOf(MANIFEST_CLOSE, open + MANIFEST_OPEN.length);
  if (end < 0) throw new Error('the build manifest block is not closed');
  return html.slice(0, open) + MANIFEST_OPEN + MANIFEST_CLOSE + html.slice(end + MANIFEST_CLOSE.length);
}

/** Images, styles and inline data URLs are not external dependencies. */
const isExternal = reference => reference.startsWith('data:') || reference.startsWith('#');

/** Boots the embedded worker runtime. Mirrors the browser worker's globals. */
export function bootRuntime(html, options = {}) {
  const source = scriptById(html, 'runtimeSource');
  const pakoSource = scriptById(html, 'pakoSource');
  const posts = [];
  const self = {
    postMessage: message => posts.push(message),
    addEventListener() {},
    removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    performance,
    crypto: crypto.webcrypto,
    console,
    navigator: { hardwareConcurrency: 4, userAgent: 'beownir-standalone-smoke' },
    location: { href: 'https://standalone.invalid/' },
  };
  self.self = self;
  self.window = self;
  self.fetch = () => Promise.reject(new Error('offline standalone smoke test'));
  const sandbox = {
    ...self,
    Buffer, URL, URLSearchParams, AbortController, TextEncoder: undefined, TextDecoder,
    Request, Response, Headers, FormData, structuredClone, atob, btoa, WeakRef, FinalizationRegistry,
    ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy,
    CompressionStream, DecompressionStream, TextEncoderStream, TextDecoderStream,
    MessageChannel, MessagePort, EventTarget, Event, AbortSignal,
    WebSocket, MessageEvent, CloseEvent: globalThis.CloseEvent, Blob,
    fetch: self.fetch,
    console,
    __hostTextEncoder: new TextEncoder(),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  if (options.mutate) options.mutate(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(`globalThis.TextEncoder = class TextEncoder {
    constructor(){ this.encoding = 'utf-8'; }
    encode(input = '') { const bytes = __hostTextEncoder.encode(String(input)); const copy = new Uint8Array(bytes.length); copy.set(bytes); return copy; }
  };`, sandbox);
  vm.runInContext(source + '\n;globalThis.__internal={CORE,FS,executeLine,executeCommand};', sandbox, { filename: 'beownir-standalone-runtime.js' });
  const internal = sandbox.__internal;
  internal.FS['/.beownir/runtime/pako.js'] = { c: pakoSource };
  if (!internal.FS['/project']) internal.FS['/project'] = { d: true, m: Date.now() };
  internal.FS['/project/package.json'] = { c: JSON.stringify({ name: 'standalone-smoke', version: '1.0.0', scripts: {} }, null, 2) + '\n', m: Date.now() };
  internal.evaluate = code => vm.runInContext(code, sandbox);
  internal.run = async line => {
    const from = posts.length;
    let code;
    try { code = await internal.executeLine(String(line)); } catch (error) { code = 1; posts.push({ type: 'stderr', data: String(error && error.message || error) + '\n' }); }
    const messages = posts.slice(from);
    const stdout = messages.filter(message => message.type === 'stdout').map(message => String(message.data)).join('');
    const stderr = messages.filter(message => message.type === 'stderr').map(message => String(message.data)).join('');
    return { code, stdout, stderr, output: stdout + stderr };
  };
  /* A miniature virtual kernel: `node -e`, `npm` and anything that asks the
   * host for a filesystem barrier or a port posts a kernel-call and waits for a
   * kernel-reply. Without this the smoke test would hang on the first command,
   * which is exactly how a half-embedded artifact fails in the browser. */
  const ports = new Set();
  const reply = (id, result, error) => sandbox.self.onmessage({ data: { type: 'kernel-reply', id, result, error } });
  const snapshot = () => {
    const files = {};
    for (const [file, entry] of Object.entries(internal.FS)) {
      if (file.startsWith('/.beownir')) continue;
      files[file] = entry && entry.d ? { d: true } : { c: entry?.c ?? '' };
    }
    return files;
  };
  internal.snapshot = snapshot;
  internal.postMessageOriginal = sandbox.self.postMessage;
  sandbox.self.postMessage = message => {
    posts.push(message);
    if (!message || message.type !== 'kernel-call') return;
    const { id, op, data } = message;
    try {
      if (op === 'barrier') return reply(id, { epoch: 1 });
      if (op === 'fs-snapshot') return reply(id, { files: snapshot(), versions: {}, epoch: 1 });
      if (op === 'bind-http') {
        let port = Number(data?.port);
        if (!port) { port = 30000; while (ports.has(port)) port += 1; }
        if (ports.has(port)) return reply(id, null, { code: 'EADDRINUSE', message: 'Virtual port in use: ' + port });
        ports.add(port);
        return reply(id, { port });
      }
      if (op === 'unbind-http') { ports.delete(Number(data?.port)); return reply(id, {}); }
      if (op === 'ps') return reply(id, [{ pid: 1, ppid: 0, state: 'running', command: 'beownir', ports: [...ports] }]);
      if (op === 'kill') return reply(id, {});
      if (op === 'http') return reply(id, null, { code: 'ECONNREFUSED', message: 'standalone smoke test has no network' });
      return reply(id, null, { code: 'ENOSYS', message: 'unsupported in the standalone smoke kernel: ' + op });
    } catch (error) { return reply(id, null, { code: 'ERR_KERNEL', message: String(error && error.message || error) }); }
  };
  /* The reload path the IDE uses: a fresh worker receives `init` with the whole
   * project plus the embedded pako/esbuild blobs, then reports `ready`. */
  internal.reload = async files => {
    sandbox.self.onmessage({ data: { type: 'init', files, versions: {}, config: {}, embeddedPako: pakoSource, embeddedEsbuildBrowser: '', embeddedEsbuildWasm: new Uint8Array(0) } });
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const seen = Object.keys(internal.FS).filter(key => !key.startsWith('/.beownir') && key !== '/');
      if (Object.keys(files).every(key => key in internal.FS) && seen.length) return true;
    }
    return false;
  };
  internal.ports = ports;
  internal.posts = posts;
  internal.sandbox = sandbox;
  return internal;
}

/**
 * Verifies and boots an artifact. Returns { ok, lines, problems, timings }.
 * Every line is written for the reports, so the numbers come from a real run.
 */
export async function smokeArtifact(file) {
  const lines = [];
  const problems = [];
  const timings = {};
  const started = performance.now();
  if (!fs.existsSync(file)) return { ok: false, lines: ['artifact not found: ' + file], problems: ['artifact not found'], timings };

  const html = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(html, 'utf8');
  lines.push('artifact    ' + (bytes / 1048576).toFixed(2) + ' MiB, sha256 ' + sha256(html).slice(0, 16));

  // 1. immutable manifest. The helpers are repeated here (rather than imported
  // from build-standalone.mjs) so this verifier only depends on the artifact:
  // importing the builder would also import its top-level await.
  const manifest = readManifest(html);
  if (!manifest) problems.push('no build manifest');
  else {
    const digest = sha256(withoutManifest(html));
    if (digest !== manifest.document.sha256) problems.push('document digest does not match the manifest');
    lines.push('manifest    format ' + manifest.format + ', ' + manifest.sources.length + ' sources, ' + manifest.assets.length + ' assets');
  }

  // 2. every embedded script parses
  const scripts = [];
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = match[1];
    const type = (/type="([^"]*)"/.exec(attrs) || [])[1] || 'text/javascript';
    const id = (/id="([^"]*)"/.exec(attrs) || [])[1] || null;
    scripts.push({ attrs, id, type, body: match[2] });
  }
  const parseStarted = performance.now();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beownir-standalone-'));
  let parsed = 0;
  try {
    for (const script of scripts) {
      const isCode = script.type === 'text/javascript' || script.type === 'module' || ['runtimeSource', 'runtimeFrameSource', 'previewBridgeSource', 'coiServiceWorkerSource'].includes(script.id);
      if (!isCode || !script.body.trim()) continue;
      // The host source is an ES module (it imports node:net and friends), so it
      // needs a module parse; `node --check` on a temp file uses the same parser
      // the browser/host will use without pulling anything from the repo.
      const isModule = script.type === 'module' || /(^|\n)\s*(?:import\s[\s\S]*?from\s|import\s*['"]|export\s)/.test(script.body);
      const file = path.join(temporary, (script.id || 'block') + (isModule ? '.mjs' : '.js'));
      fs.writeFileSync(file, script.body);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        parsed++;
      } catch (error) {
        const message = String(error.stderr || error.message || error).split('\n').filter(Boolean).slice(-3).join(' ');
        problems.push('script block does not parse (' + (script.id || script.type) + '): ' + message);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  timings.parseMs = performance.now() - parseStarted;
  lines.push('scripts     ' + parsed + ' blocks parse (' + timings.parseMs.toFixed(1) + ' ms)');

  // 3. external embedded esbuild wasm check (pure browser bundle)
  const wasmMatch = /<script id="esbuildWasm"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!wasmMatch) problems.push('esbuildWasm block is missing');
  else {
    const rawWasm = zlib.gunzipSync(Buffer.from(wasmMatch[1].trim(), 'base64'), { maxOutputLength: 64 * 1024 * 1024 });
    if (!(rawWasm[0] === 0x00 && rawWasm[1] === 0x61 && rawWasm[2] === 0x73 && rawWasm[3] === 0x6d)) problems.push('esbuildWasm is not a valid WebAssembly module');
    lines.push('wasm        esbuild.wasm decoded (' + (rawWasm.length / 1048576).toFixed(2) + ' MiB)');
  }

  // 4. the artifact does not demand a separate mandatory file
  // Only the document *markup* and real worker bootstraps matter here. URL
  // strings inside application/template source (the project templates the IDE
  // writes into a user's workspace) are not dependencies of the artifact.
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, match => (/^<script\b[^>]*\bsrc=/.test(match) ? match : ''));
  const external = new Set();
  for (const match of markup.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="([^"#:]+)"/g)) external.add(match[1]);
  for (const match of html.matchAll(/new Worker\(\s*['"]([^'"]+)['"]/g)) external.add(match[1]);
  const mandatory = [...external].filter(reference => !isExternal(reference))
    .filter(reference => !['coi-sw.js'].includes(reference));
  if (mandatory.length) problems.push('artifact requires external files: ' + mandatory.join(', '));
  lines.push('external    ' + (external.size ? [...external].sort().join(', ') : 'none (workers boot from embedded sources)'));

  // 5. boot the embedded runtime and run real commands
  try {
    const bootStarted = performance.now();
    const runtime = bootRuntime(html);
    timings.bootMs = performance.now() - bootStarted;
    const checks = [];
    checks.push(['boot', runtime.CORE && typeof runtime.executeLine === 'function']);
    const pwd = await runtime.run('pwd');
    checks.push(['pwd', /\/project/.test(pwd.output)]);
    const write = await runtime.run('echo hello > note.txt');
    const read = await runtime.run('cat note.txt');
    checks.push(['filesystem', write.code === 0 && /hello/.test(read.output)]);
    const node = await runtime.run("node -e \"console.log(require('crypto').createHash('sha256').update('abc').digest('hex').slice(0,8))\"");
    checks.push(['node -e', node.code === 0 && /ba7816bf/.test(node.output)]);
    const esm = await runtime.run("node -e \"const fs=require('fs');fs.writeFileSync('/project/m.mjs','export const x=42');const m=require('/project/m.mjs');console.log('esm:'+m.x)\"");
    checks.push(['esm require', /esm:42/.test(esm.output)]);
    const buffer = await runtime.run("node -e \"const b=Buffer.alloc(6);b.writeUInt16BE(0xbeef,0);console.log(b.toString('hex'),b.readInt8(0))\"");
    checks.push(['buffer', /beef00000000 -66/.test(buffer.output)]);
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (failed.length) problems.push('runtime smoke checks failed: ' + failed.join(', '));
    lines.push('runtime     booted in ' + timings.bootMs.toFixed(0) + ' ms, ' + (checks.length - failed.length) + '/' + checks.length + ' checks: ' + checks.map(([name, ok]) => name + (ok ? '✓' : '✗')).join(' '));

    /* 6. persistence across a reload uses the same message the IDE kernel sends
     * (setfiles), so the test exercises the production path rather than poking
     * at the virtual tree directly. */
    const snapshot = runtime.snapshot();
    const second = bootRuntime(html);
    await second.reload(snapshot);
    const restored = await second.run('cat note.txt');
    if (!/hello/.test(restored.output)) problems.push('a file written before the reload was not restored by setfiles');
    lines.push('persistence ' + (snapshot['/project/note.txt'] ? 'restored through init ✓' : 'no file to restore ✗'));
  } catch (error) {
    problems.push('the embedded runtime did not boot: ' + (error && error.stack || error));
  }

  timings.totalMs = performance.now() - started;
  lines.push('timings     boot ' + (timings.bootMs || 0).toFixed(0) + ' ms, parse ' + (timings.parseMs || 0).toFixed(0) + ' ms, total ' + timings.totalMs.toFixed(0) + ' ms');
  for (const problem of problems) lines.push('FAIL ' + problem);
  return { ok: problems.length === 0, lines, problems, timings, manifest };
}

if (process.argv[1] && process.argv[1].endsWith('standalone-smoke.mjs')) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve('beownir-standalone.html');
  const report = await smokeArtifact(file);
  for (const line of report.lines) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}
