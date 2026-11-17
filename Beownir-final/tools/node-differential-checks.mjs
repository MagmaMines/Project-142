// Snippets evaluated in real Node and in the runtime; the result must match.
export const checks = [
  ['argv-shape', `[typeof process.argv[0] === 'string', Array.isArray(process.argv)]`],
  ['exitCode-default', `process.exitCode`],
  ['title', `typeof process.title`],
  ['pid-type', `typeof process.pid`],
  ['require-main-is-module', `require.main === module`],
  ['require-main-type', `typeof require.resolve.paths('fs')`],
  ['module-parent-required', `typeof module.parent`],
  ['filename', `__filename`],
  ['dirname', `__dirname`],
  ['require-cache-has-self', `Object.keys(require.cache).length > 0`],
  ['require-resolve-paths', `require.resolve.paths('fs')`],
  ['circular-partial', `(() => { return require('./circ').seen; })()`],
  ['exports-reassign', `require('./reassign')`],
  ['json-require', `require('./data.json')`],
  ['json-cache', `require('./data.json') === require('./data.json')`],
  ['buffer-toJSON', `JSON.stringify(Buffer.from('hi'))`],
  ['buffer-slice-share', `(() => { const b = Buffer.from('abcd'); const s = b.subarray(1, 3); s[0] = 90; return b.toString(); })()`],
  ['buffer-compare', `Buffer.from('a').compare(Buffer.from('b'))`],
  ['buffer-equals', `Buffer.from('a').equals(Buffer.from('a'))`],
  ['buffer-keys', `Object.keys(Buffer.from('ab'))`],
  ['inspect-circular', `(() => { const o = { a: 1 }; o.self = o; return require('util').inspect(o); })()`],
  ['inspect-depth', `require('util').inspect({ a: { b: { c: { d: { e: 1 } } } } })`],
  ['inspect-colors', `require('util').inspect({ a: 1 }, { colors: false })`],
  ['inspect-custom', `(() => { class X { [require('util').inspect.custom]() { return 'X!'; } } return require('util').inspect(new X()); })()`],
  ['format-specifiers', `require('util').format('%s|%d|%i|%f|%j|%%', 'a', 1, '2.9', 3.5, { b: 1 })`],
  ['format-extra', `require('util').format('%s', 'a', 'b', 3)`],
  ['console-format', `(() => { const lines = []; const log = console.log; console.log = (...a) => lines.push(require('util').format(...a)); console.log('%s is %d', 'x', 7); console.log('obj', { a: [1] }); console.log = log; return lines; })()`],
  ['error-stack-head', `(() => { const e = new Error('boom'); return String(e.stack).split('\\n')[0]; })()`],
  ['error-name', `(() => { try { null.x; } catch (e) { return e.constructor.name + ':' + (e instanceof TypeError); } })()`],
  ['tostring-error', `String(new Error('x'))`],
  ['nexttick-order', `(async () => { const order = []; setTimeout(() => order.push('timer'), 0); process.nextTick(() => order.push('tick')); await new Promise(r => setTimeout(r, 20)); return order; })()`],
  ['setimmediate-exists', `typeof setImmediate`],
  ['hrtime-bigint', `typeof process.hrtime.bigint()`],
  ['path-edge', `[require('path').join('a/', '/b'), require('path').normalize('/a/../../b'), require('path').extname('.env'), require('path').basename('/a/b/')]`],
  ['path-resolve', `require('path').resolve('/a', '../b')`],
  ['path-relative', `require('path').relative('/a/b', '/a/c')`],
  ['url-parse', `(() => { const u = new URL('https://user:pw@example.test:8080/a/b?x=1#f'); return [u.hostname, u.port, u.pathname, u.search, u.hash, u.username]; })()`],
  ['url-fileURLToPath', `require('url').fileURLToPath('file:///a/b%20c')`],
  ['url-pathToFileURL', `require('url').pathToFileURL('/a b').href`],
  ['searchparams', `(() => { const p = new URLSearchParams('a=1&b=2&b=3'); return [p.get('b'), p.getAll('b').length, p.toString()]; })()`],
  ['fs-readdir-types', `(() => { const fs = require('fs'); fs.mkdirSync(process.cwd() + '/listing', { recursive: true }); fs.writeFileSync(process.cwd() + '/listing/one.txt', '1'); fs.writeFileSync(process.cwd() + '/listing/two.txt', '2'); return fs.readdirSync(process.cwd() + '/listing', { withFileTypes: true }).map(d => d.name + ':' + d.isFile()).sort().slice(0, 3); })()`],
  ['fs-stats', `(() => { const s = require('fs').statSync(process.cwd() + '/data.json'); return [s.isFile(), s.isDirectory(), typeof s.size]; })()`],
  ['fs-readfile-encoding', `require('fs').readFileSync(process.cwd() + '/data.json', 'utf8').trim()`],
  ['fs-mkdir-recursive-returns', `(() => { const fs = require('fs'); try { return fs.mkdirSync(process.cwd() + '/x/y/z', { recursive: true }); } catch (e) { return 'threw:' + e.code; } })()`],
  ['fs-write-encoding', `(() => { const fs = require('fs'); fs.writeFileSync(process.cwd() + '/enc.txt', 'héllo', 'utf8'); return fs.readFileSync(process.cwd() + '/enc.txt', 'utf8'); })()`],
  ['fs-errno', `(() => { try { require('fs').readFileSync(process.cwd() + '/nope.txt'); } catch (e) { return [e.code, e.syscall, e.errno < 0, e.path]; } })()`],
  ['fs-promises-identity', `require('fs').promises === require('node:fs/promises')`],
  ['events-once-error', `(() => new Promise(resolve => { const { EventEmitter, once } = require('events'); const e = new EventEmitter(); once(e, 'x').then(() => resolve('resolved'), err => resolve('rejected:' + err.message)); e.emit('x'); }))()`],
  ['events-capture', `(() => { const { EventEmitter, captureRejections } = require('events'); return typeof captureRejections; })()`],
  ['stream-pipeline', `(async () => { const { Readable, Writable, pipeline } = require('stream'); const out = []; await new Promise((resolve, reject) => pipeline(Readable.from(['a', 'b']), new Writable({ write(c, e, cb) { out.push(String(c)); cb(); } }), error => error ? reject(error) : resolve())); return out; })()`],
  ['stream-transform', `(async () => { const { Readable, Transform } = require('stream'); const up = new Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } }); const out = []; for await (const c of Readable.from(['a', 'b']).pipe(up)) out.push(String(c)); return out; })()`],
  ['zlib-roundtrip', `(() => { const z = require('zlib'); return z.gunzipSync(z.gzipSync(Buffer.from('hello'))).toString(); })()`],
  ['crypto-hash', `require('crypto').createHash('sha256').update('abc').digest('hex')`],
  ['crypto-randomuuid-len', `require('crypto').randomUUID().length`],
  ['assert-throws-message', `(() => { try { require('assert').strictEqual(1, 2); } catch (e) { return e.code; } })()`],
  ['assert-deep-cross', `(() => { try { require('assert').deepStrictEqual({ a: [1] }, { a: [1] }); return 'ok'; } catch (e) { return e.code; } })()`],
  ['structuredclone', `structuredClone({ a: [1, 2], b: new Map([[1, 2]]) }).a[1]`],
  ['iterator-helpers', `typeof [].values().map`],
  ['intl', `new Intl.NumberFormat('en-US').format(1234.5)`],
  ['atomics', `typeof SharedArrayBuffer`],
  ['timers-promises', `(async () => { const { setTimeout: sleep } = require('timers/promises'); const t = Date.now(); await sleep(5); return Date.now() - t >= 4; })()`],
  ['string-decoder', `(() => { const d = new (require('string_decoder').StringDecoder)('utf8'); return d.write(Buffer.from('hé')); })()`],
  ['querystring', `require('querystring').stringify({ a: 1, b: 'x y' })`],
  ['punycode', `require('punycode').toASCII('mañana.com')`],
  ['os-eol', `require('os').EOL`],
  ['vm-context', `(() => { const vm = require('vm'); const c = vm.createContext({ x: 1 }); return vm.runInContext('x + 1', c); })()`],
  // util.types: bundlers and assert libraries branch on these exact predicates.
  ['types-primitives', `(() => {
    const { types } = require('util');
    const values = [1, 'a', true, null, undefined, Symbol('s'), 1n, {}, [], () => {}, new Date(), /x/, new Map(), new Set(), new WeakMap(), new WeakSet(), new Error('x'), Promise.resolve(), new ArrayBuffer(1), new Uint8Array(1), Buffer.from('a'), new DataView(new ArrayBuffer(1))];
    const names = ['isAnyArrayBuffer', 'isArgumentsObject', 'isArrayBuffer', 'isAsyncFunction', 'isBigInt64Array', 'isBigUint64Array', 'isBooleanObject', 'isBoxedPrimitive', 'isDataView', 'isDate', 'isExternal', 'isFloat32Array', 'isFloat64Array', 'isGeneratorFunction', 'isGeneratorObject', 'isInt8Array', 'isInt16Array', 'isInt32Array', 'isMap', 'isMapIterator', 'isModuleNamespaceObject', 'isNativeError', 'isNumberObject', 'isPromise', 'isProxy', 'isRegExp', 'isSet', 'isSetIterator', 'isSharedArrayBuffer', 'isStringObject', 'isSymbolObject', 'isTypedArray', 'isUint8Array', 'isUint8ClampedArray', 'isUint16Array', 'isUint32Array', 'isWeakMap', 'isWeakSet'];
    return names.map(name => [name, values.map(value => (typeof types[name] === 'function' ? types[name](value) : 'missing'))]);
  })()`],
  ['types-arraybuffer-vs-view', `(() => {
    const { types } = require('util');
    return [types.isArrayBuffer(new ArrayBuffer(2)), types.isArrayBuffer(new Uint8Array(2)), types.isAnyArrayBuffer(new Uint8Array(2)), types.isTypedArray(new DataView(new ArrayBuffer(2))), types.isTypedArray(Buffer.from('a'))];
  })()`],
  ['types-boxed', `(() => {
    const { types } = require('util');
    return [types.isBooleanObject(new Boolean(false)), types.isNumberObject(new Number(0)), types.isStringObject(new String('')), types.isSymbolObject(Object(Symbol())), types.isBoxedPrimitive(new Number(1)), types.isBoxedPrimitive(1)];
  })()`],
  ['format-inspect-nested', `require('util').format('%o', { a: { b: 1 } })`],
  ['promisify-util', `(() => {
    const { promisify } = require('util');
    const fn = promisify((value, callback) => callback(null, value * 2));
    return typeof fn === 'function' && fn.length === 0;
  })()`],
  ['inherits-util', `(() => {
    const { inherits } = require('util');
    function A() {} function B() {}
    inherits(B, A);
    return [new B() instanceof A, Object.getPrototypeOf(B.prototype) === A.prototype];
  })()`],
  ['deprecate-util', `(() => {
    const { deprecate } = require('util');
    const wrapped = deprecate(function (a) { return a + 1; }, 'old');
    const described = Object.getOwnPropertyDescriptor(wrapped, 'name');
    return [wrapped(1), typeof deprecate, described === undefined];
  })()`],
  ['parseargs-util', `(() => {
    const { parseArgs } = require('util');
    const { values, positionals } = parseArgs({ args: ['-x', 'a1', '--flag', '--num', '5', 'pos'], options: { x: { type: 'boolean' }, flag: { type: 'boolean' }, num: { type: 'string' } } });
    return [values, positionals];
  })()`],
  /* --- surface completeness added by the 2026-11 audit ---
   * Each entry below is a behaviour that was *wrong* (not merely absent) when
   * it was found; the comment records what the runtime did before. */
  ['buffer-int-accessors', `(() => {
    const b = Buffer.alloc(16);
    b.writeUInt8(200, 0); b.writeInt8(-5, 1); b.writeUInt16BE(0xbeef, 2); b.writeUInt16LE(0x1234, 4);
    b.writeInt16BE(-300, 6); b.writeInt32BE(-70000, 8); b.writeUInt32LE(0xdeadbeef, 12);
    return [b.readUInt8(0), b.readUint8(0), b.readInt8(1), b.readUInt16BE(2), b.readUInt16LE(4), b.readInt16BE(6), b.readInt32BE(8), b.readUInt32LE(12)];
  })()`],
  ['buffer-variable-width-int', `(() => {
    const b = Buffer.alloc(6);
    b.writeUIntBE(0x0102030405, 0, 5); b.writeIntLE(-2, 5, 1);
    return [b.toString('hex'), b.readUIntBE(0, 5), b.readIntLE(5, 1), b.readUIntLE(0, 3), b.readIntBE(0, 5)];
  })()`],
  ['buffer-float-bigint', `(() => {
    const b = Buffer.alloc(16);
    b.writeFloatBE(1.5, 0); b.writeDoubleLE(-2.25, 4); b.writeBigUInt64BE(1234567890123456789n, 8);
    b.writeBigInt64BE(-42n, 0);
    return [b.readFloatBE(0), b.readDoubleLE(4), typeof b.readBigUInt64LE(8), b.readBigInt64BE(0), b.readBigUint64LE(8) === b.readBigUInt64LE(8)];
  })()`],
  ['buffer-range-errors', `(() => {
    const b = Buffer.alloc(2); const out = [];
    try { b.writeUInt8(300, 0); } catch (e) { out.push(e.code); }
    try { b.readUInt32BE(0); } catch (e) { out.push(e.code); }
    try { Buffer.alloc(3).swap16(); } catch (e) { out.push(e.code); }
    return out;
  })()`],
  /* indexOf(string) returned -1, so splitting a buffer on a separator looped
   * forever or produced a single chunk. */
  ['buffer-search', `(() => {
    const b = Buffer.from('a,b,c');
    const parts = []; let from = 0;
    for (;;) { const at = b.indexOf(',', from); if (at === -1) { parts.push(b.subarray(from).toString()); break; } parts.push(b.subarray(from, at).toString()); from = at + 1; }
    return [parts, b.indexOf('c'), b.indexOf(0x2c), b.lastIndexOf(','), b.includes('b'), Buffer.from('abc').indexOf(''), Buffer.from('héllo').indexOf('llo')];
  })()`],
  ['buffer-swap-fill', `(() => {
    const s16 = Buffer.from([1, 2, 3, 4]).swap16();
    const s32 = Buffer.from([1, 2, 3, 4]).swap32();
    const s64 = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64();
    return [[...s16], [...s32], [...s64], [...Buffer.alloc(5).fill('ab')], [...Buffer.alloc(4, 7)]];
  })()`],
  /* captureRejections: an async listener used to become an unhandled rejection,
   * which in a Worker tears down the whole execution group. */
  ['events-capture-rejections', `(async () => {
    const { EventEmitter } = require('events');
    const e = new EventEmitter({ captureRejections: true });
    const seen = [];
    e.on('error', error => seen.push('error:' + error.message));
    e.on('x', async () => { throw new Error('async-fail'); });
    e.emit('x');
    await new Promise(resolve => setTimeout(resolve, 10));
    return seen;
  })()`],
  /* Node calls captureRejectionSymbol with the rejection reason (the second
   * argument is undefined in Node 22), so the check records what arrived. */
  ['events-rejection-symbol', `(async () => {
    const { EventEmitter, captureRejectionSymbol } = require('events');
    const e = new EventEmitter({ captureRejections: true });
    const seen = [];
    e[captureRejectionSymbol] = function (reason, ...rest) { seen.push([reason && reason.message, rest.length, arguments.length]); };
    e.on('y', async () => { throw new Error('boom'); });
    e.emit('y');
    await new Promise(resolve => setTimeout(resolve, 10));
    return seen;
  })()`],
  ['events-error-monitor', `(() => {
    const { EventEmitter, errorMonitor } = require('events');
    const e = new EventEmitter(); const seen = [];
    e.on(errorMonitor, error => seen.push('monitor:' + error.message));
    e.on('error', () => seen.push('handler'));
    e.emit('error', new Error('x'));
    return seen;
  })()`],
  ['events-unhandled-error', `(() => {
    const { EventEmitter } = require('events');
    try { new EventEmitter().emit('error', 'not-an-error'); } catch (error) { return [error.code, error.context]; }
    return 'no-throw';
  })()`],
  ['events-max-listeners', `(() => {
    const { EventEmitter } = require('events');
    const e = new EventEmitter();
    e.setMaxListeners(3);
    const own = e.getMaxListeners();
    return [own, EventEmitter.defaultMaxListeners, e.removeAllListeners() === e, e.eventNames()];
  })()`],
  /* Writable state: `writableLength`/`writableNeedDrain` were undefined, so the
   * canonical backpressure loop `if (!dest.write(chunk)) await once(dest,'drain')`
   * never waited. */
  ['stream-writable-state', `(async () => {
    const { Writable } = require('stream');
    const w = new Writable({ highWaterMark: 4, write(chunk, enc, cb) { setTimeout(cb, 1); } });
    const first = w.write('ab');
    const second = w.write('cdefg');
    const length = w.writableLength;
    const ended = w.writableEnded;
    await new Promise(resolve => w.end(resolve));
    return [first, second, length > 0, ended, w.writableEnded, w.writableFinished, w.writableHighWaterMark, w.writableObjectMode];
  })()`],
  ['stream-readable-state', `(() => {
    const { Readable } = require('stream');
    const r = new Readable({ read() {} });
    r.push(Buffer.from('abc'));
    return [r.readableLength, r.readableHighWaterMark, r.readableObjectMode, r.isPaused(), r.readableEnded, typeof r.pipe, typeof r.iterator];
  })()`],
  ['stream-iterator-helpers', `(async () => {
    const { Readable } = require('stream');
    const source = () => Readable.from([Buffer.from('1'), Buffer.from('2'), Buffer.from('3')]);
    const mapped = []; for await (const chunk of source().map(c => String(c) + '!')) mapped.push(chunk);
    const filtered = []; for await (const chunk of source().filter(c => String(c) !== '2')) filtered.push(String(chunk));
    const taken = []; for await (const chunk of source().take(2)) taken.push(String(chunk));
    return [mapped, filtered, taken, await source().toArray().then(list => list.length)];
  })()`],
  ['stream-web-interop', `(async () => {
    const { Readable, Writable } = require('stream');
    const web = Readable.toWeb(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    const reader = web.getReader(); const decoder = new TextDecoder(); let text = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    const back = [];
    for await (const chunk of Readable.fromWeb(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('xy')); c.close(); } }))) back.push(String(chunk));
    const written = [];
    const sink = Writable.toWeb(new Writable({ write(chunk, enc, cb) { written.push(String(chunk)); cb(); } }));
    const writer = sink.getWriter(); await writer.write('z'); await writer.close();
    return [text, back.join(''), written];
  })()`],
  /* pipeline() with a generator stage silently dropped every byte. */
  ['stream-pipeline-function-stage', `(async () => {
    const zlib = require('zlib');
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');
    const out = [];
    await pipeline(
      Readable.from([Buffer.from('abc')]),
      zlib.createGzip(),
      zlib.createGunzip(),
      async function* (source) { for await (const chunk of source) out.push(String(chunk)); },
    );
    return out.join('');
  })()`],
  ['stream-promises-returns-promise', `(async () => {
    const { Readable, Writable } = require('stream');
    const { pipeline, finished } = require('stream/promises');
    const collected = [];
    const result = pipeline(Readable.from([Buffer.from('a')]), new Writable({ write(c, e, cb) { collected.push(String(c)); cb(); } }));
    const isPromise = typeof result?.then === 'function';
    await result;
    const stream = Readable.from([Buffer.from('b')]);
    const finishedResult = finished(stream);
    return [isPromise, typeof finishedResult?.then === 'function', collected.join('')];
  })()`],
  ['fs-readdir-recursive', `(() => {
    const fs = require('fs'), path = require('path'), base = process.cwd();
    fs.mkdirSync(base + '/rec/x', { recursive: true });
    fs.writeFileSync(base + '/rec/a.txt', 'a');
    fs.writeFileSync(base + '/rec/x/b.txt', 'b');
    return fs.readdirSync(base + '/rec', { recursive: true }).map(String).sort();
  })()`],
  ['fs-utimes-atime', `(() => {
    const fs = require('fs'), base = process.cwd();
    fs.writeFileSync(base + '/stamp.txt', 'x');
    fs.utimesSync(base + '/stamp.txt', 1000000, 2000000);
    const stats = fs.statSync(base + '/stamp.txt');
    return [Math.round(stats.atimeMs / 1000), Math.round(stats.mtimeMs / 1000), stats.atime instanceof Date, stats.mtime instanceof Date];
  })()`],
  ['fs-lstat-symlink', `(() => {
    const fs = require('fs'), base = process.cwd();
    fs.writeFileSync(base + '/link-target.txt', 'payload');
    fs.symlinkSync('link-target.txt', base + '/link-alias.txt');
    return [fs.lstatSync(base + '/link-alias.txt').isSymbolicLink(), fs.statSync(base + '/link-alias.txt').isSymbolicLink(), fs.readlinkSync(base + '/link-alias.txt'), fs.readFileSync(base + '/link-alias.txt', 'utf8')];
  })()`],
  ['fs-access-error-shape', `(() => {
    const fs = require('fs'), base = process.cwd();
    try { fs.accessSync(base + '/definitely-missing.txt'); } catch (error) { return [error.code, error.errno, error.syscall, error.path.replace(base, '')]; }
    return 'no-throw';
  })()`],
  ['fs-constants-table', `(() => {
    const c = require('fs').constants;
    return [c.F_OK, c.R_OK, c.W_OK, c.X_OK, c.O_RDONLY, c.S_IFMT, c.S_IFDIR, c.COPYFILE_EXCL, c.COPYFILE_FICLONE, c.O_DIRECTORY];
  })()`],
  /* readFileSync(path, 'utf16le') decoded as UTF-8: the bytes were right, the
   * string was garbage. */
  ['fs-readfile-encodings', `(() => {
    const fs = require('fs'), base = process.cwd();
    fs.writeFileSync(base + '/enc16.txt', 'hé', 'utf16le');
    fs.writeFileSync(base + '/encb64.txt', 'hello');
    return [fs.readFileSync(base + '/enc16.txt', 'utf16le'), fs.readFileSync(base + '/encb64.txt', 'base64'), fs.readFileSync(base + '/encb64.txt', 'hex'), fs.readFileSync(base + '/enc16.txt').toString('utf16le')];
  })()`],
  ['util-parseargs-short-alias', `(() => {
    const { parseArgs } = require('util');
    const { values } = parseArgs({ args: ['-p', '3000', '--name=x'], options: { port: { type: 'string', short: 'p' }, name: { type: 'string' } } });
    return [values, Object.keys(values).sort()];
  })()`],
  ['util-promisify-custom', `(async () => {
    const { promisify } = require('util');
    const fn = (value, callback) => callback(null, value * 2);
    fn[promisify.custom] = value => Promise.resolve(value * 3);
    return await promisify(fn)(2);
  })()`],
  ['zlib-error-code', `(() => {
    const zlib = require('zlib');
    try { zlib.inflateSync(Buffer.from('not zlib data')); } catch (error) { return [error.code, error.errno]; }
    return 'no-throw';
  })()`],
  ['crypto-timing-safe-equal-error', `(() => {
    const { timingSafeEqual } = require('crypto');
    try { timingSafeEqual(Buffer.from('a'), Buffer.from('ab')); } catch (error) { return [error.code, error.name]; }
    return 'no-throw';
  })()`],
  ['os-constants-signals', `(() => {
    const os = require('os');
    return [os.constants.signals.SIGTERM, os.constants.signals.SIGKILL, os.constants.signals.SIGINT, os.constants.errno.EACCES, os.constants.priority.PRIORITY_NORMAL];
  })()`],
  ['tty-isatty', `(() => {
    const tty = require('tty');
    return [tty.isatty(0), tty.isatty(1), tty.isatty(2)];
  })()`],
  ['url-http-options', `(() => {
    const { urlToHttpOptions } = require('url');
    const options = urlToHttpOptions(new URL('https://user:pw@example.test:8443/p?q=1'));
    return [options.port, typeof options.port, options.hostname, options.path, options.auth];
  })()`],

  ['rsa-sign-sha256', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const key = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    return [key.type, key.asymmetricKeyType, key.asymmetricKeyDetails.modulusLength, crypto.sign('sha256', Buffer.from('beownir'), key).toString('hex')];
  })()`],
  ['rsa-sign-createSign', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const key = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update('beownir');
    signer.update(' rocks');
    return [signer.sign(key, 'base64'), crypto.sign('RSA-SHA256', Buffer.from('beownir rocks'), key).toString('base64')];
  })()`],
  ['rsa-verify', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const privateKey = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    const publicKey = crypto.createPublicKey(fs.readFileSync('key.pub.pem', 'utf8'));
    const signature = crypto.sign('sha256', Buffer.from('beownir'), privateKey);
    const verifier = crypto.createVerify('sha256');
    verifier.update('beownir');
    return [verifier.verify(publicKey, signature), crypto.verify('sha256', Buffer.from('other'), publicKey, signature), crypto.verify('sha256', Buffer.from('beownir'), publicKey, signature)];
  })()`],
  ['rsa-key-export', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const key = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    const pkcs1 = key.export({ type: 'pkcs1', format: 'pem' });
    const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
    const roundTrip = crypto.createPrivateKey(pkcs1);
    return [pkcs1.split('\\n')[0], spki.split('\\n')[0], roundTrip.asymmetricKeyDetails.modulusLength, key.equals(roundTrip), key.export({ type: 'pkcs8', format: 'der' }).length > 0];
  })()`],
  ['rsa-public-encrypt', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const privateKey = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    const publicKey = crypto.createPublicKey(fs.readFileSync('key.pub.pem', 'utf8'));
    const ciphertext = crypto.publicEncrypt(publicKey, Buffer.from('secret payload'));
    const plaintext = crypto.privateDecrypt(privateKey, ciphertext);
    const reverse = crypto.publicDecrypt(publicKey, crypto.privateEncrypt(privateKey, Buffer.from('signed payload')));
    return [ciphertext.length, plaintext.toString(), reverse.toString()];
  })()`],
  ['rsa-oaep-encrypt', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const privateKey = crypto.createPrivateKey(fs.readFileSync('key.pem', 'utf8'));
    const publicKey = crypto.createPublicKey(fs.readFileSync('key.pub.pem', 'utf8'));
    const options = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
    const ciphertext = crypto.publicEncrypt({ key: publicKey, ...options }, Buffer.from('oaep payload'));
    // Decrypting an OAEP ciphertext with PKCS#1 v1.5 padding must fail. Without
    // this assertion the case passes even when the padding option is ignored.
    const wrongPadding = (() => { try { crypto.privateDecrypt(privateKey, ciphertext); return 'accepted'; } catch { return 'rejected'; } })();
    return [ciphertext.length, crypto.privateDecrypt({ key: privateKey, ...options }, ciphertext).toString(), wrongPadding];
  })()`],
  ['rsa-errors', `(() => {
    const crypto = require('crypto');
    const fs = require('fs');
    const publicKey = crypto.createPublicKey(fs.readFileSync('key.pub.pem', 'utf8'));
    const thrower = fn => { try { fn(); return 'no-throw'; } catch (error) { return [error.code, /too large/.test(error.message)]; } };
    return [thrower(() => crypto.publicEncrypt(publicKey, Buffer.alloc(300))), thrower(() => crypto.createPrivateKey('-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----'))];
  })()`],
];
