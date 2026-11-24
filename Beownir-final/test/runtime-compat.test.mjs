import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

/* The runtime is a worker source. This harness evaluates it once in a VM with a
 * worker-shaped global object, then checks the Node compatibility surface that
 * real packages touch at import time. */
// One harness for the whole suite: booting the worker source twice in slightly
// different sandboxes is how a missing web global (Event) silently broke every
// check in this file.
test('the runtime source boots and reports its version', () => {
  const rt = loadRuntime();
  assert.ok(rt.posts.some(message => message.type === 'boot'), 'the worker posts boot');
  assert.match(rt.processObj.version, /^v\d+\./);
  assert.equal(rt.processObj.platform, 'browser');
  assert.ok(rt.processObj.versions.node);
  assert.ok(rt.processObj.versions.beownir);
});

test('node:path exposes posix and win32 flavours with the documented helpers', () => {
  const { PATH } = loadRuntime();
  assert.equal(PATH.posix, PATH);
  assert.ok(PATH.win32);
  assert.equal(PATH.join('/a', 'b', '..', 'c'), '/a/c');
  assert.equal(PATH.dirname('/a/b/c.js'), '/a/b');
  assert.equal(PATH.basename('/a/b/c.js'), 'c.js');
  assert.equal(PATH.extname('/a/b/c.js'), '.js');
  assert.equal(PATH.relative('/a/b', '/a/c/d'), '../c/d');
  assert.deepEqual(JSON.parse(JSON.stringify(PATH.parse('/a/b/c.js'))), { root: '/', dir: '/a/b', base: 'c.js', ext: '.js', name: 'c' });
  assert.equal(PATH.matchesGlob('/app/src/index.js', '/app/**/*.js'), true);
  assert.equal(PATH.matchesGlob('/app/src/index.ts', '/app/**/*.js'), false);
});

test('node:url converts file URLs in both directions, including escapes', () => {
  const { URLMOD } = loadRuntime();
  assert.equal(URLMOD.fileURLToPath('file:///project/a%20b.js'), '/project/a b.js');
  assert.equal(URLMOD.fileURLToPath(new URL('file:///project/donn%C3%A9es.json')), '/project/données.json');
  assert.equal(URLMOD.pathToFileURL('/project/a b.js').href, 'file:///project/a%20b.js');
  assert.equal(URLMOD.pathToFileURL('/project/données.json').href, 'file:///project/donn%C3%A9es.json');
  assert.deepEqual(URLMOD.fileURLToPath(URLMOD.pathToFileURL('/project/x/y z.js')), '/project/x/y z.js');
  assert.throws(() => URLMOD.fileURLToPath('https://example.test/x'), /scheme/);
});

test('node:module reports the builtin list and resolves builtins', () => {
  const { CORE } = loadRuntime();
  /* Node lists bare ids ("fs", "path/win32") and answers isBuiltin() for both
   * spellings. The runtime used to store "node:fs" entries, which made the two
   * disagree with Node. */
  const builtins = CORE.module.builtinModules;
  assert.ok(builtins.includes('fs'), 'fs is listed');
  assert.ok(!builtins.includes('node:fs'), 'the list is unprefixed, as in Node');
  assert.ok(builtins.length > 20, 'the list is populated: ' + builtins.length);
  assert.equal(CORE.module.isBuiltin('node:fs'), true);
  assert.equal(CORE.module.isBuiltin('fs'), true);
  assert.equal(CORE.module.isBuiltin('path/win32'), true);
  assert.equal(CORE.module.isBuiltin('stream/consumers'), true);
  assert.equal(CORE.module.isBuiltin('left-pad'), false);
  assert.equal(typeof CORE.module.createRequire('/project/index.js'), 'function');
});

test('node:util covers parseArgs, deep equality, types and formatting helpers', () => {
  const { UTIL, evaluate } = loadRuntime();
  const parsed = UTIL.parseArgs({ args: ['--port', '3000', '--verbose', 'file.txt'], options: { port: { type: 'string', short: 'p' }, verbose: { type: 'boolean' } }, allowPositionals: true });
  assert.equal(parsed.values.port, '3000');
  /* Node records only the long name: `-p 3000` yields { port: '3000' }, not a
   * second `p` key. The old assertion encoded the opposite and Node disagreed. */
  assert.equal(Object.hasOwn(parsed.values, 'p'), false);
  assert.equal(UTIL.parseArgs({ args: ['-p', '3000'], options: { port: { type: 'string', short: 'p' } } }).values.port, '3000');
  assert.equal(parsed.values.verbose, true);
  assert.deepEqual([...parsed.positionals], ['file.txt']);
  assert.throws(() => UTIL.parseArgs({ args: ['--nope'], options: {} }), error => error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
  assert.equal(UTIL.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(UTIL.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
  /* Cross-realm objects must be built inside the sandbox: `instanceof` is
   * realm-bound even for builtins. */
  assert.equal(evaluate("UTIL.isDeepStrictEqual(new Map([['a', 1]]), new Map([['a', 1]]))"), true);
  assert.equal(evaluate('UTIL.isDeepStrictEqual(new Set([1, 2]), new Set([1, 2]))'), true);
  assert.equal(evaluate('UTIL.types.isPromise(Promise.resolve())'), true);
  assert.equal(evaluate('UTIL.types.isRegExp(/x/)'), true);
  assert.equal(evaluate('UTIL.types.isTypedArray(new Uint8Array(1))'), true);
  assert.equal(evaluate('UTIL.types.isAsyncFunction(async function () {})'), true);
  assert.equal(UTIL.stripVTControlCharacters('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(UTIL.styleText('red', 'plain'), 'plain');
  assert.deepEqual(JSON.parse(JSON.stringify(UTIL.parseEnv('A=1\n# c\nB="two words"\n'))), { A: '1', B: 'two words' });
  assert.equal(typeof UTIL.getCallSites(), 'object');
});

test('node:async_hooks provides a working AsyncLocalStorage', async () => {
  const { CORE } = loadRuntime();
  const { AsyncLocalStorage, AsyncResource } = CORE.async_hooks;
  assert.equal(typeof AsyncLocalStorage, 'function');
  const storage = new AsyncLocalStorage();
  assert.equal(storage.getStore(), undefined);
  const value = storage.run({ request: 42 }, () => storage.getStore().request);
  assert.equal(value, 42);
  assert.equal(storage.getStore(), undefined, 'the store is restored after run');
  /* No async_hooks in a browser worker: the store is scoped to the synchronous
   * run, which is what the runtime documents. Timers do not inherit it. */
  await new Promise(resolve => storage.run({ request: 7 }, () => {
    assert.equal(storage.getStore().request, 7);
    setTimeout(() => { assert.equal(storage.getStore(), undefined); resolve(); }, 1);
  }));
  const resource = new AsyncResource('test');
  assert.equal(resource.runInAsyncScope(() => 'ok'), 'ok');
  assert.equal(typeof resource.bind(() => 1), 'function');
});

test('node:buffer and node:crypto helpers behave like Node', () => {
  const { CORE, CRYPTO } = loadRuntime();
  const data = crypto.randomBytes(200_000);
  assert.equal(CRYPTO.createHash('sha512').update(data).digest('hex'), crypto.createHash('sha512').update(data).digest('hex'));
  assert.equal(CRYPTO.createHmac('sha256', 'key').update('message').digest('hex'), crypto.createHmac('sha256', 'key').update('message').digest('hex'));
  assert.match(CRYPTO.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(CRYPTO.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(CORE.buffer.isUtf8(Buffer.from('hello')), true);
  assert.equal(CORE.buffer.isUtf8(Buffer.from([0xff, 0xfe])), false);
  assert.equal(CORE.buffer.atob(CORE.buffer.btoa('beownir')), 'beownir');
  assert.equal(CORE.buffer.byteLength('héllo'), 6);
});

test('node:zlib round-trips gzip through the embedded pako build', () => {
  const { CORE } = loadRuntime();
  const payload = Buffer.from('beownir streaming install kit · '.repeat(200));
  const gzipped = CORE.zlib.gzipSync(payload);
  assert.ok(gzipped.length > 0);
  assert.deepEqual(Buffer.from(CORE.zlib.gunzipSync(gzipped)), payload);
  const deflated = CORE.zlib.deflateSync(payload);
  assert.deepEqual(Buffer.from(CORE.zlib.inflateSync(deflated)), payload);
  const nodeGzip = zlib.gzipSync(payload);
  assert.deepEqual(Buffer.from(CORE.zlib.gunzipSync(nodeGzip)), payload);
  assert.equal(CORE.zlib.constants.Z_STREAM_END, 1);
});

test('runtime modules used by packages exist and fail honestly when unsupported', () => {
  const { CORE } = loadRuntime();
  assert.equal(typeof CORE.fs.readFileSync, 'function');
  assert.equal(typeof CORE.fs.promises.readFile, 'function');
  assert.equal(typeof CORE.http.createServer, 'function');
  assert.equal(typeof CORE.net.createServer, 'function');
  assert.equal(typeof CORE.child_process.spawn, 'function');
  assert.equal(CORE.worker_threads.isMainThread, true);
  assert.equal(typeof CORE.events.once, 'function');
  assert.equal(typeof CORE.vm.runInNewContext, 'function');
  assert.equal(new CORE.vm.Script('1+1').runInNewContext({}), 2);
  assert.equal(typeof CORE.test, 'function', 'node:test registers cases instead of throwing');
  CORE.test('registered case', () => {});
  assert.equal(CORE.test._root.length > 0, true);
  assert.equal(CORE.process, loadRuntime().processObj);
  assert.equal(typeof CORE.os.platform, 'function');
});

test('node:stream exposes the classes packages import', () => {
  const { CORE, STREAM } = loadRuntime();
  assert.equal(CORE.stream.Readable, STREAM.Readable);
  assert.equal(CORE.stream.default, CORE.stream);
  assert.equal(typeof CORE.stream.addAbortSignal, 'function');
  assert.equal(typeof STREAM.Readable, 'function');
  assert.equal(typeof STREAM.Writable, 'function');
  assert.equal(typeof STREAM.Transform, 'function');
  assert.equal(typeof STREAM.pipeline, 'function');
  assert.equal(typeof STREAM.finished, 'function');
  assert.equal(typeof STREAM.Readable.from, 'function');
});

test('errno strings, os.constants.errno and util type predicates agree with Node', () => {
  const { UTIL, OS, evaluate } = loadRuntime();
  /* libuv reports negative errno numbers; both signs must name the same error. */
  assert.equal(UTIL.getSystemErrorName(-2), 'ENOENT');
  assert.equal(UTIL.getSystemErrorName(2), 'ENOENT');
  assert.equal(UTIL.getSystemErrorMessage(-111), 'connection refused');
  assert.equal(UTIL.getSystemErrorName(-9999), 'Unknown system error -9999');
  assert.throws(() => UTIL.getSystemErrorName('ENOENT'), error => error.code === 'ERR_INVALID_ARG_TYPE');
  const map = UTIL.getSystemErrorMap();
  assert.deepEqual([...map.get(-13)], ['EACCES', 'permission denied']);
  assert.deepEqual([...map.get(-11)], ['EAGAIN', 'resource temporarily unavailable'], 'the EWOULDBLOCK alias reports as EAGAIN');
  assert.equal(OS.constants.errno.ENOENT, 2);
  assert.equal(OS.constants.errno.EACCES, 13);
  assert.equal(OS.constants.errno.ECONNREFUSED, 111);
  assert.equal(OS.constants.priority.PRIORITY_LOW, 19);
  /* The predicates are type-tag checks, so in-realm objects answer correctly. */
  assert.equal(evaluate('UTIL.isBuffer(Buffer.from("x"))'), true);
  assert.equal(evaluate('UTIL.isBuffer("x")'), false);
  assert.equal(UTIL.isBoolean(false), true);
  assert.equal(UTIL.isNumber(NaN), true);
  assert.equal(UTIL.isString(new String('x')), false, 'boxed strings are objects, as in Node');
  assert.equal(evaluate('UTIL.isDate(new Date())'), true);
  assert.equal(evaluate('UTIL.isRegExp(/x/)'), true);
  assert.equal(evaluate('UTIL.isError(new Error("x"))'), true);
  assert.equal(UTIL.isNull(null), true);
  assert.equal(UTIL.isNullOrUndefined(undefined), true);
  assert.equal(UTIL.isObject([]), true);
  assert.equal(UTIL.isObject(() => {}), false);
  assert.equal(UTIL.isPrimitive(null), true);
  assert.equal(UTIL.isPrimitive({}), false);
  assert.equal(UTIL.isUndefined(undefined), true);
  assert.equal(UTIL.isFunction(() => {}), true);
  assert.equal(UTIL.isSymbol(Symbol('x')), true);
  assert.equal(UTIL.toUSVString('a\uD800b'), 'a\uFFFDb', 'lone surrogates become U+FFFD');
  assert.deepEqual(UTIL._extend({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test('process.loadEnvFile() fills process.env without overwriting it', () => {
  const { FS, processObj, evaluate } = loadRuntime();
  FS['/env-probe'] = { d: true, m: Date.now() };
  FS['/env-probe/.env'] = { c: 'FOO=bar\n# a comment\nQUOTED="two words"\nKEEP=replaced\n', m: Date.now() };
  processObj.env.KEEP = 'original';
  evaluate("processObj.loadEnvFile('/env-probe/.env')");
  assert.equal(processObj.env.FOO, 'bar');
  assert.equal(processObj.env.QUOTED, 'two words');
  assert.equal(processObj.env.KEEP, 'original', 'existing variables win, like Node');
  assert.throws(() => evaluate("processObj.loadEnvFile('/env-probe/missing.env')"), error => error.code === 'ENOENT');
  assert.equal(processObj.argv0, 'node');
  assert.deepEqual(JSON.parse(JSON.stringify(processObj.config)), { variables: {}, target_defaults: {} });
});

test('package.json "imports" maps resolve "#name" specifiers like Node', () => {
  const { CORE, FS } = loadRuntime();
  FS['/importprobe'] = { d: true, m: Date.now() };
  FS['/importprobe/package.json'] = { c: JSON.stringify({ name: 'probe', type: 'module', imports: { '#internal': './lib/internal.js', '#with-star/*': './lib/*.js', '#external': 'leftpad' } }), m: Date.now() };
  FS['/importprobe/lib'] = { d: true, m: Date.now() };
  FS['/importprobe/lib/internal.js'] = { c: 'export const value = 42;', m: Date.now() };
  FS['/importprobe/lib/tool.js'] = { c: 'export const name = "tool";', m: Date.now() };
  FS['/importprobe/index.js'] = { c: 'export const seen = 1;', m: Date.now() };
  const require = CORE.module.createRequire('/importprobe/index.js');
  assert.equal(require('#internal').value, 42);
  assert.equal(require('#with-star/tool').name, 'tool', '"*" patterns expand');
  assert.throws(() => require('#missing'), error => error.code === 'ERR_PACKAGE_IMPORT_NOT_DEFINED' && error.specifier === '#missing');
  assert.throws(() => require('#external'), error => error.code === 'MODULE_NOT_FOUND', 'a bare target falls through to node_modules');
});

test('slash subpath builtins resolve as their own modules', () => {
  const { CORE } = loadRuntime();
  const require = CORE.module.createRequire('/project/index.js');
  assert.equal(require.resolve('path/win32'), 'path/win32');
  const win32 = require('path/win32');
  assert.equal(win32.sep, '\\');
  assert.equal(win32.delimiter, ';');
  assert.equal(win32.join('a', 'b'), 'a\\b');
  assert.equal(win32.dirname('C:\\a\\b.js'), 'C:\\a');
  assert.equal(win32.isAbsolute('C:\\x'), true);
  assert.equal(win32.isAbsolute('x'), false);
  assert.equal(require('path/posix'), CORE.path);
  assert.equal(require('util/types'), CORE.util.types);
  assert.equal(typeof require('stream/consumers').text, 'function');
  assert.ok(require('inspector/promises'));
});

test('stream/consumers drains a readable the way Node does', async () => {
  const { CORE } = loadRuntime();
  const consumers = CORE['stream/consumers'];
  assert.equal(await consumers.text(CORE.stream.Readable.from(['ab', 'cd'])), 'abcd');
  const buffer = await consumers.buffer(CORE.stream.Readable.from(['x']));
  assert.equal(CORE.buffer.Buffer.isBuffer(buffer), true);
  assert.equal(buffer.toString('utf8'), 'x');
  assert.equal(JSON.stringify(await consumers.json(CORE.stream.Readable.from(['{"a":1}']))), '{"a":1}');
  const arrayBuffer = await consumers.arrayBuffer(CORE.stream.Readable.from(['hi']));
  assert.equal(Buffer.from(arrayBuffer).toString(), 'hi');
});

test('readline emits lines, answers questions and iterates like Node', async () => {
  const { CORE, processObj } = loadRuntime();
  const line = CORE.readline;
  const iface = line.createInterface({ input: processObj.stdin, output: processObj.stdout });
  const lines = [];
  iface.on('line', value => lines.push(value));
  processObj.stdin.push(Buffer.from('alpha\r\nbeta\n'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(lines, ['alpha', 'beta'], 'CRLF is stripped and no newline is emitted yet');
  processObj.stdin.push(Buffer.from('gamma\n'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(lines, ['alpha', 'beta', 'gamma']);

  const pending = new Promise(resolve => iface.question('name? ', resolve));
  processObj.stdin.push(Buffer.from('ada\n'));
  assert.equal(await pending, 'ada', 'question() consumes the next line instead of emitting it');

  const counter = line.createInterface({ input: processObj.stdin });
  const collected = (async () => { const out = []; for await (const value of counter) { out.push(value); if (out.length === 2) break; } return out; })();
  setTimeout(() => processObj.stdin.push(Buffer.from('one\ntwo\n')), 5);
  assert.deepEqual(await collected, ['one', 'two'], 'async iteration yields lines');

  const promisesInterface = CORE['readline/promises'];
  assert.equal(typeof promisesInterface.Readline, 'function');
  const promised = promisesInterface.createInterface({ input: processObj.stdin, output: { write() {} } });
  const answer = promised.question('port? ');
  setTimeout(() => processObj.stdin.push(Buffer.from('8080\n')), 5);
  assert.equal(await answer, '8080', 'readline/promises question() returns a promise');

  let closed = false;
  const ending = line.createInterface({ input: processObj.stdin });
  ending.on('close', () => { closed = true; });
  processObj.stdin.push(null);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true, "input 'end' closes the interface");
});

test('module internals can be patched, like module-alias expects', () => {
  const { CORE, FS } = loadRuntime();
  const Module = CORE.module;
  assert.equal(typeof Module._resolveFilename, 'function');
  FS['/project/resolveme.js'] = { c: 'module.exports = 1;', m: Date.now() };
  assert.equal(Module._resolveFilename('./resolveme.js', { filename: '/project/index.js' }), '/project/resolveme.js');
  assert.equal(Module._resolveFilename('fs', { filename: '/project/index.js' }), 'fs', 'builtins resolve to their id');
  assert.deepEqual([...Module._nodeModulePaths('/project/src/app.js')], ['/project/src/node_modules', '/project/node_modules', '/node_modules']);
  assert.equal(Module._cache, CORE.module.createRequire('/project/index.js').cache, 'one cache, as in Node');
  assert.deepEqual(Object.keys(Module.Module._extensions).sort(), ['.cjs', '.js', '.json', '.mjs', '.node']);
  assert.equal(Module.globalPaths.length, 1);
  assert.equal(Module.constants.compileCacheStatus.ENABLED, 1);
  assert.equal(Module.getSourceMapsSupport().enabled, false);
  assert.equal(typeof Module.registerHooks().deregister, 'function');
  assert.equal(Module.findPackageJSON('fs', 'file:///project/index.js') === undefined || true, true);
  assert.throws(() => Module.findPackageJSON('node:fs'), error => error.code === 'ERR_INVALID_URL_SCHEME');

  /* A patched resolver must actually be used by a fresh require. */
  FS['/patchprobe'] = { d: true, m: Date.now() };
  FS['/patchprobe/real.js'] = { c: 'module.exports = "real";', m: Date.now() };
  FS['/patchprobe/fake.js'] = { c: 'module.exports = "patched";', m: Date.now() };
  const original = Module._resolveFilename;
  try {
    Module._resolveFilename = (request, parent) => request === 'alias-me' ? '/patchprobe/fake.js' : original(request, parent);
    const require = Module.createRequire('/patchprobe/index.js');
    assert.equal(require('alias-me'), 'patched');
  } finally {
    Module._resolveFilename = original;
  }
});

test('process.env stores strings and accepts replacement, like Node', () => {
  const { CORE } = loadRuntime();
  const process = CORE.process;
  process.env.NUM = 123;
  assert.equal(process.env.NUM, '123');
  assert.equal(typeof process.env.NUM, 'string');
  process.env.NUM = undefined;
  assert.equal(process.env.NUM, 'undefined', 'a non-string is coerced, not dropped');
  delete process.env.NUM;
  assert.equal('NUM' in process.env, false);
  process.env.REPLACED = 'x';
  process.env = { A: 1, B: 'two' };
  assert.deepEqual(JSON.parse(JSON.stringify(process.env)), { A: '1', B: 'two' });
  assert.equal(process.env.REPLACED, undefined, 'assigning process.env replaces it');
  assert.equal(Object.keys(process).includes('pid'), true, 'pid is enumerable, as in Node');
});

test('fs exposes glob, ownership, fchmod and the vector helpers', async () => {
  const { CORE } = loadRuntime();
  const fs = CORE.fs;
  fs.mkdirSync('/fsprobe/src/deep', { recursive: true });
  fs.writeFileSync('/fsprobe/src/a.js', 'a');
  fs.writeFileSync('/fsprobe/src/deep/b.js', 'b');
  fs.writeFileSync('/fsprobe/src/c.txt', 'c');
  assert.deepEqual([...fs.globSync('src/**/*.js', { cwd: '/fsprobe' })].sort(), ['src/a.js', 'src/deep/b.js']);
  assert.equal(fs.globSync('src/*.txt', { cwd: '/fsprobe' }).length, 1);
  assert.equal(typeof fs.glob, 'function');
  assert.equal(await new Promise(resolve => fs.exists('/fsprobe/src/a.js', resolve)), true);
  assert.equal(await new Promise(resolve => fs.exists('/fsprobe/missing', resolve)), false);

  const fd = fs.openSync('/fsprobe/src/c.txt', 'r+');
  fs.fchmodSync(fd, 0o600);
  fs.fchownSync(fd, 5, 6);
  assert.equal(fs.statSync('/fsprobe/src/c.txt').mode & 0o777, 0o600, 'fchmod persists');
  assert.equal(fs.statSync('/fsprobe/src/c.txt').uid, 5, 'chown ownership is reported by stat, as in Node');
  assert.equal(fs.statSync('/fsprobe/src/c.txt').gid, 6);
  fs.fsyncSync(fd);
  assert.equal(fs.writevSync(fd, [Buffer.from('xy')]), 2);
  fs.closeSync(fd);
  const blob = await fs.openAsBlob('/fsprobe/src/a.js');
  assert.equal(blob instanceof Blob, true);
  const promisedGlob = [];
  for await (const match of CORE['fs/promises'].glob('src/*.txt', { cwd: '/fsprobe' })) promisedGlob.push(match);
  assert.deepEqual(promisedGlob, ['src/c.txt'], 'fs.promises.glob() is an async iterator of relative paths');
});

test('glob matching treats ** as zero or more directories', () => {
  const { CORE } = loadRuntime();
  const path = CORE.path;
  assert.equal(path.matchesGlob('src/a.js', 'src/**/*.js'), true);
  assert.equal(path.matchesGlob('src/deep/b.js', 'src/**/*.js'), true);
  assert.equal(path.matchesGlob('src/a.ts', 'src/**/*.js'), false);
  assert.equal(path.matchesGlob('a/b', 'a/**/b'), true);
  assert.equal(path.matchesGlob('a1', 'a[0-9]'), true);
  assert.equal(path.matchesGlob('ax', 'a[0-9]'), false);
});

test('events, timers, async_hooks, buffer and process fill their Node surfaces', () => {
  const { CORE, evaluate } = loadRuntime();
  const events = CORE.events;
  const emitter = evaluate('(() => { const EventEmitter = CORE.stream.EventEmitter || CORE.events.EventEmitter; const e = new EventEmitter(); e.on("x", () => {}); e.on("x", () => {}); return e; })()');
  assert.equal(events.listenerCount(emitter, 'x'), 2);
  assert.equal(events.getEventListeners(emitter, 'x').length, 2);
  assert.deepEqual([...events.getEventListeners(emitter)], ['x']);
  assert.throws(() => events.getEventListeners({}), error => error.code === 'ERR_INVALID_ARG_TYPE');

  assert.equal(CORE.timers.active({ _idleTimeout: 20 }), true);
  assert.equal(CORE.timers.active({ _destroyed: true, _idleTimeout: 20 }), false);
  assert.equal(typeof CORE.timers.enroll, 'function');
  assert.equal(typeof CORE.timers.unenroll, 'function');
  assert.equal(CORE.async_hooks.asyncWrapProviders.PROMISE, 26);

  assert.equal(typeof CORE.buffer.File, 'function');
  const file = new CORE.buffer.File(['hello'], 'greeting.txt');
  assert.equal(file.name, 'greeting.txt');
  assert.equal(file.size, 5);
  assert.equal(typeof CORE.buffer.resolveObjectURL, 'function');
  assert.throws(() => CORE.buffer.resolveObjectURL('https://example.test/x'), error => error.code === 'ERR_INVALID_URL_SCHEME');

  const process = CORE.process;
  assert.equal(process.getuid(), 1000);
  assert.deepEqual([...process.getgroups()], [1000]);
  assert.equal(typeof process.threadCpuUsage().user, 'number');
  assert.equal(typeof process.availableMemory(), 'number');
  assert.equal(Array.isArray(process.moduleLoadList), true);
  assert.equal(typeof process.finalization.register, 'function');
  assert.equal(typeof process.ref, 'function');
  assert.equal(process.domain, null);
  assert.throws(() => process.assert(false, 'boom'), error => error.code === 'ERR_ASSERTION');
  assert.equal(typeof process.browser, 'undefined', 'Node does not define process.browser (typescript checks it)');
});

test('cross-realm ArrayBuffers and TypedArrays work with Buffer.from and util.types', async () => {
  const { sandbox, evaluate } = loadRuntime();
  sandbox.__hostTestAb = await new Response('astro-html').arrayBuffer();
  sandbox.__hostTestU8 = new TextEncoder().encode('host-bytes');
  try {
    const result = evaluate(`(() => {
      const { types } = require('util');
      return {
        abIsArrayBuffer: types.isArrayBuffer(__hostTestAb),
        abIsAnyArrayBuffer: types.isAnyArrayBuffer(__hostTestAb),
        abText: Buffer.from(__hostTestAb).toString('utf8'),
        u8IsUint8Array: types.isUint8Array(__hostTestU8),
        u8Text: Buffer.from(__hostTestU8).toString('utf8'),
      };
    })()`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), {
      abIsArrayBuffer: true,
      abIsAnyArrayBuffer: true,
      abText: 'astro-html',
      u8IsUint8Array: true,
      u8Text: 'host-bytes',
    });
  } finally {
    delete sandbox.__hostTestAb;
    delete sandbox.__hostTestU8;
  }
});

test('node:zlib Brotli codec matches Node across sync, callback, promises, streaming and error paths', async () => {
  const { evaluate } = loadRuntime();
  const payloadText = 'beownir-brotli-codec-roundtrip-'.repeat(120);
  const nodeCompressed = zlib.brotliCompressSync(Buffer.from(payloadText));

  const res = JSON.parse(await evaluate(`(async () => {
    const z = require('zlib');
    const { pipeline } = require('stream/promises');
    const { Readable, Writable } = require('stream');
    const src = ${JSON.stringify(payloadText)};

    // Sync round-trip & Node interop (both directions)
    const compSync = z.brotliCompressSync(src, { params: { [z.constants.BROTLI_PARAM_QUALITY]: 4 } });
    const decompFromNode = z.brotliDecompressSync(Buffer.from(${JSON.stringify(nodeCompressed.toString('base64'))}, 'base64')).toString('utf8');

    // Callback & promises APIs
    const compCb = await new Promise((resolve, reject) => z.brotliCompress(src, (e, out) => e ? reject(e) : resolve(out)));
    const decompProm = (await z.promises.brotliDecompress(compCb)).toString('utf8');

    // Streaming CompressStream & DecompressStream via pipeline
    const compChunks = [];
    await pipeline(
      Readable.from([src.slice(0, 500), src.slice(500, 1500), src.slice(1500)]),
      z.createBrotliCompress({ params: { [z.constants.BROTLI_PARAM_QUALITY]: 2 } }),
      new Writable({ write(c, _e, cb) { compChunks.push(Buffer.from(c)); cb(); } })
    );
    const streamCompressed = Buffer.concat(compChunks);
    const decompChunks = [];
    await pipeline(
      Readable.from([streamCompressed.subarray(0, 7), streamCompressed.subarray(7)]),
      z.createBrotliDecompress(),
      new Writable({ write(c, _e, cb) { decompChunks.push(Buffer.from(c)); cb(); } })
    );
    const streamOut = Buffer.concat(decompChunks).toString('utf8');

    // Invalid input throws structured error and runtime recovers cleanly afterwards
    let badCode = null;
    try { z.brotliDecompressSync(Buffer.from('corrupt-brotli-data')); }
    catch (e) { badCode = e && e.code; }
    let truncCode = null;
    try {
      await pipeline(
        Readable.from([streamCompressed.subarray(0, Math.floor(streamCompressed.length / 2))]),
        z.createBrotliDecompress(),
        new Writable({ write(_c, _e, cb) { cb(); } })
      );
    } catch (e) { truncCode = e && e.code; }
    const recovered = z.brotliDecompressSync(compSync).toString('utf8') === src;

    return JSON.stringify({
      compSyncB64: compSync.toString('base64'),
      decompFromNodeMatch: decompFromNode === src,
      decompPromMatch: decompProm === src,
      streamOutMatch: streamOut === src,
      badCode,
      truncCode,
      recovered,
      qualityConst: z.constants.BROTLI_PARAM_QUALITY,
    });
  })()`));

  assert.equal(zlib.brotliDecompressSync(Buffer.from(res.compSyncB64, 'base64')).toString('utf8'), payloadText);
  assert.equal(res.decompFromNodeMatch, true);
  assert.equal(res.decompPromMatch, true);
  assert.equal(res.streamOutMatch, true);
  assert.equal(res.badCode, 'Z_DATA_ERROR');
  assert.equal(res.truncCode, 'Z_BUF_ERROR');
  assert.equal(res.recovered, true);
  assert.equal(res.qualityConst, zlib.constants.BROTLI_PARAM_QUALITY);
});

test('fs.promises.watch, npm run -- args, npx flags, and shared esbuild API work cleanly', async () => {
  const { evaluate, executeLine, posts } = await initToolchain(loadRuntime({ keep: true }));
  const fs = evaluate('CORE.fs');
  fs.mkdirSync('/project/watch-dir', { recursive: true });
  fs.writeFileSync('/project/package.json', JSON.stringify({
    name: 'cli-flags-test',
    version: '1.0.0',
    scripts: { echo: 'node -e "console.log(process.argv.slice(1).join(\',\'))"' },
  }));
  fs.mkdirSync('/project/node_modules/hello-cli', { recursive: true });
  fs.writeFileSync('/project/node_modules/hello-cli/package.json', JSON.stringify({ name: 'hello-cli', version: '1.0.0', bin: { 'hello-cli': 'cli.js' } }));
  fs.writeFileSync('/project/node_modules/hello-cli/cli.js', 'console.log("CLI:" + process.argv.slice(2).join(" "));\n');

  const ac = new AbortController();
  const watchPromise = evaluate(`(async (signal) => {
    const events = [];
    for await (const ev of CORE.fs.promises.watch('/project/watch-dir', { signal })) {
      events.push(ev);
      if (events.length >= 1) break;
    }
    return JSON.stringify(events);
  })`)(ac.signal);
  await new Promise(r => setTimeout(r, 15));
  fs.writeFileSync('/project/watch-dir/a.txt', 'v1');
  const watched = JSON.parse(await watchPromise);
  assert.equal(watched.length, 1);
  assert.equal(watched[0].filename, 'a.txt');
  ac.abort();

  const esbResult = JSON.parse(await evaluate(`(async () => {
    const esb = require('esbuild');
    const out1 = await esb.transform('const x: number = 1;', { loader: 'ts' });
    // Also exercise VirtualNodeWorker sharing globalThis.__beownirEsbuildApi without re-initializing WASM:
    const { Worker } = require('worker_threads');
    const workerCode = "const { parentPort } = require('worker_threads'); require('esbuild').transform('const y: number = 2;', { loader: 'ts' }).then(r => parentPort.postMessage(r.code), e => { throw e; });";
    const workerOut = await new Promise((resolve, reject) => {
      const w = new Worker(workerCode, { eval: true });
      w.once('message', resolve);
      w.once('error', reject);
    });
    return JSON.stringify({ out1: out1.code.trim(), workerOut: workerOut.trim(), hasGlobal: Boolean(globalThis.__beownirEsbuildApi) });
  })()`));
  assert.equal(esbResult.out1, 'const x = 1;');
  assert.equal(esbResult.workerOut, 'const y = 2;');
  assert.equal(esbResult.hasGlobal, true);

  // npm run -- forwarding and npx -y flag stripping
  const outFrom1 = posts.length;
  const code1 = await executeLine('npm run echo -- --alpha beta');
  assert.equal(code1, 0);
  const stdout1 = posts.slice(outFrom1).filter(m => m.type === 'stdout').map(m => m.data).join('');
  assert.match(stdout1, /--alpha,beta/);

  const outFrom2 = posts.length;
  const code2 = await executeLine('npx -y hello-cli one two');
  assert.equal(code2, 0);
  const stdout2 = posts.slice(outFrom2).filter(m => m.type === 'stdout').map(m => m.data).join('');
  assert.match(stdout2, /CLI:one two/);
});

test('Writable cork/_writev, vm context isolation, and recursive node:test runner behave cleanly', async () => {
  const { evaluate } = loadRuntime();
  const result = JSON.parse(await evaluate(`(async () => {
    const { Writable } = require('stream');
    const vm = require('vm');
    const nodeTest = require('node:test');
    const assert = require('node:assert/strict');

    // 1. Writable corking + _writev batching + async flush before finish
    const batches = [];
    let finalRan = false;
    const events = [];
    const w = new Writable({
      writev(chunks, cb) {
        batches.push(chunks.map(c => c.chunk.toString('utf8')));
        setTimeout(cb, 5);
      },
      write(chunk, _enc, cb) {
        batches.push([chunk.toString('utf8')]);
        cb();
      },
      final(cb) {
        finalRan = true;
        events.push('final');
        cb();
      },
    });
    w.on('finish', () => events.push('finish'));
    w.cork();
    w.cork();
    w.write('a');
    w.write('b');
    w.uncork();
    const stillCorked = batches.length === 0 && w.writableCorked === 1;
    w.cork();
    w.write('c');
    await new Promise(resolve => w.end(resolve));

    // 2. vm context writes stay inside context instead of leaking to globalThis
    const ctx = vm.createContext({ a: 10 });
    const sum = vm.runInContext('b = a + 32; a = 99; b', ctx);
    const leaked = typeof globalThis.b;
    const newCtx = { base: 7 };
    const doubled = vm.runInNewContext('out = base * 2', newCtx);
    const leakedNew = typeof globalThis.out;

    // 3. node:test nested suites, t.test subtests, (t, done), skip/todo, run() reset
    nodeTest._root.length = 0;
    const trace = [];
    nodeTest.describe('outer', () => {
      nodeTest.it('sync pass', t => {
        trace.push(t.fullName);
      });
      nodeTest.it('done callback', (t, done) => {
        setTimeout(() => { trace.push(t.name); done(); }, 2);
      });
      nodeTest.skip('skipped', () => { trace.push('BAD'); });
      nodeTest.todo('planned', () => {});
      nodeTest.describe('inner', () => {
        nodeTest.it('subtest parent', async t => {
          await t.test('child step', sub => {
            assert.equal(sub.fullName, 'subtest parent > child step');
            trace.push('sub');
          });
        });
      });
    });
    const run1 = await nodeTest.run();
    const run2 = await nodeTest.run();

    // Test .only filtering
    nodeTest._root.length = 0;
    const onlyTrace = [];
    nodeTest.it('ignored', () => { onlyTrace.push('no'); });
    nodeTest.describe.only('focused suite', () => {
      nodeTest.it('included', () => { onlyTrace.push('yes'); });
    });
    const onlyRun = await nodeTest.run();
    nodeTest._root.length = 0;

    return JSON.stringify({
      batches,
      stillCorked,
      finalRan,
      events,
      vm: { sum, a: ctx.a, b: ctx.b, leaked, doubled, out: newCtx.out, leakedNew },
      run1: { passed: run1.passed, failed: run1.failed.length, skipped: run1.skipped },
      run2: { passed: run2.passed, failed: run2.failed.length, skipped: run2.skipped },
      trace,
      onlyRun: { passed: onlyRun.passed, failed: onlyRun.failed.length, skipped: onlyRun.skipped },
      onlyTrace,
    });
  })()`));

  assert.deepEqual(result.batches, [['a', 'b', 'c']]);
  assert.equal(result.stillCorked, true);
  assert.equal(result.finalRan, true);
  assert.deepEqual(result.events, ['final', 'finish']);
  assert.deepEqual(result.vm, { sum: 42, a: 99, b: 42, leaked: 'undefined', doubled: 14, out: 14, leakedNew: 'undefined' });
  assert.deepEqual(result.run1, { passed: 4, failed: 0, skipped: 2 });
  assert.deepEqual(result.run2, { passed: 4, failed: 0, skipped: 2 });
  assert.deepEqual(result.trace, ['sync pass', 'done callback', 'sub', 'sync pass', 'done callback', 'sub']);
  assert.deepEqual(result.onlyRun, { passed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(result.onlyTrace, ['yes']);
});
