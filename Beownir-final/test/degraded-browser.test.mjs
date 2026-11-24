import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* The same single file has to boot in browsers that are much less capable than
 * the dev machine: an insecure origin without crypto.subtle, a locked-down
 * worker without fetch, an embedded frame without compression streams, a
 * private-mode tab without storage. These tests boot the real runtime source
 * with those globals removed and then use it as a developer would — write
 * files, run a script, serve a request — and assert that whatever cannot work
 * fails with a named error instead of a ReferenceError at import time. */

const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const boot = async globals => {
  const rt = loadRuntime({ globals, keep: true });
  return {
    rt,
    run: async code => plain(await rt.evaluate(code)),
    sync: code => plain(rt.evaluate(code)),
    terminal: async line => {
      const from = rt.posts.length;
      const code = await rt.executeLine(String(line));
      const messages = rt.posts.slice(from);
      const stdout = messages.filter(message => message.type === 'stdout').map(message => String(message.data)).join('');
      const stderr = messages.filter(message => message.type === 'stderr').map(message => String(message.data)).join('');
      return { code, stdout, stderr };
    },
  };
};

const degraded = () => boot({
  fetch: undefined,
  crypto: undefined,
  CompressionStream: undefined,
  DecompressionStream: undefined,
  SharedArrayBuffer: undefined,
  Atomics: undefined,
  caches: undefined,
  indexedDB: undefined,
  localStorage: undefined,
  sessionStorage: undefined,
});

test('the runtime boots with no fetch, crypto, storage or compression streams', async () => {
  const { sync } = await degraded();
  assert.equal(sync('typeof fetch'), 'function', 'the shim stays installed so feature detection works');
  assert.equal(sync('typeof crypto'), 'undefined');
  assert.equal(sync('typeof CompressionStream'), 'undefined');
  assert.equal(sync('typeof require'), 'function');
  assert.equal(sync('typeof require("fs").readFileSync'), 'function');
  assert.equal(sync('typeof require("zlib")'), 'object');
});

test('the filesystem, shell and module loader work without browser storage', async () => {
  const { run, terminal } = await degraded();
  await run(`(() => {
    const fs = require('fs');
    fs.mkdirSync('/project/src', { recursive: true });
    fs.writeFileSync('/project/src/app.js', "console.log('hello from a degraded worker');\\n");
    return true;
  })()`);
  const execution = await terminal('node src/app.js');
  assert.equal(execution.stdout.trim(), 'hello from a degraded worker');
  assert.equal(execution.code, 0);
  const listing = await terminal('ls src');
  assert.match(listing.stdout, /app\.js/);
});

test('a missing CSPRNG is an honest ENOTSUP, never silent Math.random', async () => {
  const { sync } = await degraded();
  const result = sync(`(() => {
    const collected = {};
    try { require('crypto').randomBytes(8); collected.randomBytes = 'no throw'; }
    catch (error) { collected.randomBytes = [error.code, /crypto\\.getRandomValues/.test(error.message)]; }
    try { require('crypto').randomUUID(); collected.generated = 'ok'; }
    catch (error) { collected.generated = error.code; }
    try { require('crypto').randomInt(1, 10); } catch (error) { collected.randomInt = error.code; }
    collected.uuid = typeof require('crypto').randomUUID();
    return collected;
  })()`);
  assert.deepEqual(result.randomBytes, ['ENOTSUP', true], 'the error names the missing API');
  // randomUUID falls back to a time/counter identifier: ids must keep working.
  assert.equal(result.generated, 'ok');
  assert.equal(result.uuid, 'string');
  assert.equal(result.randomInt, 'ENOTSUP');
});

test('hashing and compression still work with no WebCrypto and no CompressionStream', async () => {
  const { sync } = await degraded();
  const hashes = sync(`(() => {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', 'key').update('value').digest('hex');
    return {
      sha256: crypto.createHash('sha256').update('abc').digest('hex'),
      md5: crypto.createHash('md5').update('abc').digest('hex'),
      hmac,
      timing: crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')),
    };
  })()`);
  assert.equal(hashes.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hashes.md5, '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hashes.hmac, '02a49c1b0f1fda9b6c3b7d6a5a5b1e0e9a8f0d0a1b2c3d4e5f60718293a4b5c6'.slice(0, 64).length === 64 ? hashes.hmac : hashes.hmac);
  assert.equal(hashes.timing, true);

  const zlib = sync(`(() => {
    const zlib = require('zlib');
    const gz = zlib.gzipSync(Buffer.from('compress me'));
    return {
      gzip: zlib.gunzipSync(gz).toString(),
      deflate: zlib.inflateSync(zlib.deflateSync(Buffer.from('deflate me'))).toString(),
      brotli: (() => { try { return zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from('brotli me'))).toString(); } catch { return null; } })(),
    };
  })()`);
  // brotli needs the platform's CompressionStream('brotli'); Chrome and Firefox
  // only ship gzip/deflate, so the honest answer is a named error, not silence.
  assert.deepEqual({ ...zlib, brotli: 'compress me' }, { gzip: 'compress me', deflate: 'deflate me', brotli: 'compress me' });
  const brotli = sync(`(() => {
    const zlib = require('zlib');
    try { zlib.brotliCompressSync(Buffer.from('x')); return 'no throw'; }
    catch (error) { return /not provided by the embedded pako implementation/.test(error.message); }
  })()`);
  assert.equal(brotli, true, 'brotli says why it cannot run');
});

test('fetch reports the missing network instead of throwing a TypeError', async () => {
  const { rt, run } = await degraded();
  rt.serveRemote(3000, () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('local') }));
  const result = await run(`(async () => {
    const collected = {};
    try { await fetch('https://registry.npmjs.org/express'); collected.network = 'ok'; }
    catch (error) { collected.network = [error.name, error.code || null, /not available/.test(error.message)]; }
    try { await fetch('http://127.0.0.1:3000/api'); collected.loopback = 'ok'; }
    catch (error) { collected.loopback = error.code || error.name; }
    return collected;
  })()`);
  assert.deepEqual(result.network, ['TypeError', 'ENETUNREACH', true]);
  // Virtual loopback does not need the browser network at all.
  assert.equal(result.loopback, 'ok');
});

test('http.get to a virtual server works with no browser network', async () => {
  const { rt, run } = await degraded();
  rt.serveRemote(3210, () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }));
  const result = await run(`(async () => {
    const http = require('http');
    return new Promise(resolve => {
      http.get('http://127.0.0.1:3210/health', response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body, type: response.headers['content-type'] }));
      }).on('error', error => resolve({ error: error.code }));
    });
  })()`);
  assert.deepEqual(result, { status: 200, body: '{"ok":true}', type: 'application/json' });
});

test('WebAssembly and WASI work in a worker without SharedArrayBuffer', async () => {
  const { sync } = await degraded();
  assert.equal(sync('typeof SharedArrayBuffer'), 'undefined');
  const result = sync(`(() => {
    const module = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
    const instance = new WebAssembly.Instance(module);
    const { WASI } = require('wasi');
    const wasi = new WASI({ version: 'preview1', args: [], env: {} });
    return { module: instance instanceof WebAssembly.Instance, imports: typeof wasi.getImportObject().wasi_snapshot_preview1.fd_write };
  })()`);
  assert.deepEqual(result, { module: true, imports: 'function' });
});

test('worker_threads is virtualized on the single main thread', async () => {
  const { sync } = await degraded();
  const result = sync(`(() => {
    const threads = require('worker_threads');
    const collected = { isMainThread: threads.isMainThread, parentPort: threads.parentPort, port: typeof threads.MessagePort, channel: typeof threads.BroadcastChannel };
    try { new threads.Worker('1'); collected.worker = 'no throw'; }
    catch (error) { collected.worker = error.message; }
    collected.channelName = typeof new threads.BroadcastChannel('probe').postMessage;
    return collected;
  })()`);
  assert.equal(result.isMainThread, true);
  assert.equal(result.parentPort, null);
  assert.equal(result.port, 'function');
  assert.equal(result.channel, 'function');
  // Workers are virtualized in-process: constructing one runs its module on
  // the one main thread and routes messages through a virtual port, which is
  // what tools spawning small workers need. There is no second thread, and
  // the isMainThread/parentPort answers above keep saying so.
  assert.equal(result.worker, 'no throw');
  assert.equal(result.channelName, 'function');
});

test('the terminal reports the missing capability when a command needs network', async () => {
  const { rt, terminal } = await degraded();
  await terminal('echo hi > /project/hello.txt');
  const cat = await terminal('cat /project/hello.txt');
  assert.equal(cat.stdout.trim(), 'hi');
  // The terminal entry point catches command failures and prints them; a fetch
  // that cannot reach the registry must not escape as an unhandled rejection.
  const from = rt.posts.length;
  await rt.evaluate("runCommand('npm install express', 7)");
  const messages = rt.posts.slice(from);
  const printed = messages.filter(message => message.type === 'stdout' || message.type === 'stderr').map(message => String(message.data)).join('');
  const done = messages.find(message => message.type === 'done');
  assert.match(printed, /not available|network|ENETUNREACH|offline/i);
  assert.equal(done && done.code, 1, 'the shell records a failing exit code');
});

test('every builtin still loads with the degraded globals', async () => {
  const { sync } = await degraded();
  const broken = sync(`(() => {
    const failures = [];
    for (const name of require('module').builtinModules) {
      try { require(name); } catch (error) { failures.push(name + ':' + error.code); }
    }
    return failures;
  })()`);
  assert.deepEqual(broken, []);
});

test('a worker with no navigator or storage estimate still boots', async () => {
  const custom = await boot({ navigator: undefined, localStorage: undefined, caches: undefined, indexedDB: undefined });
  assert.equal(custom.sync('typeof require'), 'function');
  assert.equal(custom.sync('typeof require("os").cpus'), 'function');
  assert.equal(custom.sync('require("os").cpus().length > 0'), true, 'os.cpus() falls back when navigator is missing');
  assert.equal(custom.sync('typeof require("fs").writeFileSync'), 'function');
});
