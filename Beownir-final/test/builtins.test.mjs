import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* console, dgram, repl, sys, trace_events and wasi were missing from the module
 * registry entirely: `require('dgram')` failed with MODULE_NOT_FOUND while
 * `module.builtinModules` advertised the name. These tests drive each one the
 * way a developer porting Node code would, including the failure paths. */

const rt = loadRuntime();

/* Values created inside the VM are instances of *that* realm's prototypes, so
 * deepStrictEqual rejects them as "same structure but not reference-equal".
 * Everything crossing the boundary is normalized to plain JSON data. */
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const evaluate = async code => plain(await rt.evaluate(code));

/** Synchronous variant for expressions that cannot be promises. */
const evaluateSync = code => plain(rt.evaluate(code));

test.beforeEach(() => rt.restore());

test('every advertised builtin can actually be required', async () => {
  const result = await evaluate(`(() => {
    const moduleApi = require('module');
    const broken = [];
    for (const name of moduleApi.builtinModules) {
      try { if (!require(name)) broken.push(name + ':empty'); }
      catch (error) { broken.push(name + ':' + error.code); }
    }
    return broken;
  })()`);
  assert.deepEqual([...result], [], 'no advertised module fails to load');
});

test('the builtin list matches the Node modules that exist, unprefixed', async () => {
  const listed = await evaluate('require("module").builtinModules');
  for (const name of ['console', 'dgram', 'repl', 'sys', 'trace_events', 'wasi']) {
    assert.ok(listed.includes(name), name + ' is listed');
    assert.equal(await evaluate(`require('module').isBuiltin(${JSON.stringify(name)})`), true, 'isBuiltin(' + name + ')');
    assert.equal(await evaluate(`require('module').isBuiltin('node:${name}')`), true, 'isBuiltin(node:' + name + ')');
  }
  for (const subpath of ['dns/promises', 'path/win32', 'stream/web', 'timers/promises', 'util/types']) {
    assert.ok(listed.includes(subpath), subpath + ' is listed, as in Node');
  }
  assert.ok(!listed.includes('node:fs'), 'entries are bare ids');
  assert.ok(!listed.some(name => name.startsWith('_')), 'deprecated internals are not advertised');
});

test('console is the global console and carries the Console class', async () => {
  assert.equal(await evaluate('require("console") === console'), true);
  assert.equal(await evaluate('require("console").Console === require("console").Console'), true);
  assert.equal(await evaluate('console instanceof require("console").Console'), true);
  // Destructuring the module must work: the methods are own properties.
  const output = await evaluate(`(() => {
    const { Console } = require('console');
    const lines = [];
    const stream = { write: text => lines.push(String(text)) };
    const logger = new Console({ stdout: stream, stderr: stream });
    logger.log('plain');
    logger.log({ port: 3000 });
    logger.count('hits');
    logger.count('hits');
    logger.countReset('hits');
    logger.count('hits');
    logger.group('grouped');
    logger.log('nested');
    logger.groupEnd();
    logger.time('t');
    logger.timeEnd('t');
    logger.assert(false, 'boom');
    logger.assert(true, 'never');
    return lines;
  })()`);
  assert.equal(output[0], 'plain\n');
  assert.equal(output[1], '{ port: 3000 }\n', 'an object is inspected, not stringified to [object Object]');
  assert.deepEqual(output.slice(2, 5), ['hits: 1\n', 'hits: 2\n', 'hits: 1\n'], 'countReset restarts the counter');
  assert.equal(output[5], 'grouped\n');
  assert.equal(output[6], '  nested\n', 'group() indents');
  assert.match(output[7], /^t: \d+\.\d{3}ms\n$/);
  assert.match(output[8], /^Assertion failed:\n$/);
  assert.equal(output[9], 'boom\n');
  assert.equal(output.length, 10, 'a passing assert prints nothing');
});

test('console timeLog and trace behave like Node', async () => {
  const output = await evaluate(`(() => {
    const { Console } = require('console');
    const lines = [];
    const logger = new Console({ stdout: { write: t => lines.push(String(t)) }, stderr: { write: t => lines.push(String(t)) } });
    logger.time('work');
    logger.timeLog('work', 'step 1');
    logger.timeEnd('work');
    logger.timeEnd('missing');
    logger.trace('here');
    return lines;
  })()`);
  assert.match(output[0], /^work: \d+\.\d{3}ms step 1\n$/);
  assert.match(output[1], /^work: \d+\.\d{3}ms\n$/);
  assert.equal(output.length, 3, 'timeEnd on a missing label is silent');
  assert.match(output[2], /^Trace: here\n\s+at /);
});

test('console.createTask returns the task object React feature-detects', async () => {
  // React's scheduler checks `typeof console.createTask === 'function'` and then
  // calls task.run(work). Returning a Console instead broke every React render.
  const result = await evaluate(`(() => {
    const task = console.createTask('render');
    const context = console.context('worker');
    return {
      keys: Object.getOwnPropertyNames(task),
      run: typeof task.run,
      value: task.run(() => 42),
      contextIsConsole: context instanceof console.Console,
      contextRun: typeof context.run,
    };
  })()`);
  assert.deepEqual(result.keys, ['run']);
  assert.equal(result.run, 'function');
  assert.equal(result.value, 42, 'run() returns what the callback returns');
  assert.equal(result.contextIsConsole, true);
  assert.equal(result.contextRun, 'undefined', 'context() is a Console, createTask() is a task');
});

test('sys is the deprecated alias of util, not a copy', async () => {
  assert.equal(await evaluate('require("sys") === require("util")'), true);
  assert.equal(await evaluate('require("sys").format("%s=%d", "a", 1)'), 'a=1');
  assert.equal(await evaluate('require("sys").inherits === require("util").inherits'), true);
});

test('dgram delivers datagrams between sockets in the same runtime', async () => {
  const result = await evaluate(`(async () => {
    const dgram = require('dgram');
    const server = dgram.createSocket('udp4');
    const client = dgram.createSocket('udp4');
    const seen = [];
    server.on('message', (message, info) => {
      seen.push({ text: message.toString(), port: info.port, family: info.family, address: info.address, size: info.size });
      server.send(Buffer.from('pong:' + message), info.port, info.address);
    });
    await new Promise(resolve => server.bind(45001, '127.0.0.1', resolve));
    const reply = await new Promise(resolve => {
      client.once('message', message => resolve(message.toString()));
      client.send('ping', 45001, '127.0.0.1');
    });
    const address = server.address();
    const clientPort = client.address().port;
    server.close();
    client.close();
    return { seen, reply, address, clientPort };
  })()`);
  assert.equal(result.seen.length, 1);
  // rinfo must describe the sender: a server replying to info.port has to reach
  // the client. Reporting the destination port instead made the reply loop back
  // into the server and grow the heap until the tab died.
  assert.equal(result.seen[0].text, 'ping');
  assert.equal(result.seen[0].port, result.clientPort, 'info.port is the sender port');
  assert.equal(result.seen[0].family, 'IPv4');
  assert.equal(result.seen[0].address, '127.0.0.1');
  assert.equal(result.seen[0].size, 4);
  assert.equal(result.reply, 'pong:ping');
  assert.deepEqual({ ...result.address }, { address: '127.0.0.1', family: 'IPv4', port: 45001 });
});

test('dgram reports bind, send and close failures with Node error codes', async () => {
  const errors = await evaluate(`(() => {
    const dgram = require('dgram');
    const first = dgram.createSocket('udp4');
    first.bind(45002);
    const second = dgram.createSocket('udp4');
    const collected = {};
    try { second.bind(45002); } catch (error) { collected.inUse = [error.code, error.syscall, /EADDRINUSE/.test(error.message)]; }
    try { dgram.createSocket('tcp'); } catch (error) { collected.badType = [error.constructor.name, error.code]; }
    try { dgram.createSocket('udp4').bind(70000); } catch (error) { collected.badPort = [error.constructor.name, error.code]; }
    try { dgram.createSocket('udp4').address(); } catch (error) { collected.unbound = error.code; }
    first.close();
    try { first.close(); } catch (error) { collected.doubleClose = [error.code, error.syscall]; }
    return collected;
  })()`);
  assert.deepEqual(errors.inUse, ['EADDRINUSE', 'bind', true]);
  assert.deepEqual(errors.badType, ['TypeError', 'ERR_INVALID_ARG_VALUE']);
  assert.deepEqual(errors.badPort, ['RangeError', 'ERR_SOCKET_BAD_PORT']);
  assert.equal(errors.unbound, 'ERR_SOCKET_DGRAM_NOT_RUNNING');
  assert.deepEqual(errors.doubleClose, ['ERR_SOCKET_DGRAM_NOT_RUNNING', 'close']);
});

test('dgram refuses to pretend a datagram left the browser', async () => {
  const result = await evaluate(`(async () => {
    const socket = require('dgram').createSocket('udp4');
    const error = await new Promise(resolve => {
      socket.once('error', resolve);
      socket.send('x', 53, '8.8.8.8', () => {});
    });
    socket.close();
    return { code: error.code, message: error.message };
  })()`);
  assert.equal(result.code, 'ENOTSUP');
  assert.match(result.message, /not reachable from a browser/);
  assert.match(result.message, /fetch\/WebSocket/, 'the error says what to use instead');
});

test('dgram supports connect, offset sends and the documented send callback', async () => {
  const result = await evaluate(`(async () => {
    const dgram = require('dgram');
    const server = dgram.createSocket('udp4');
    const client = dgram.createSocket('udp4');
    const received = [];
    server.on('message', (message, info) => received.push([message.toString(), info.size]));
    await new Promise(resolve => server.bind(45003, '127.0.0.1', resolve));
    await new Promise(resolve => client.connect(45003, '127.0.0.1', resolve));
    const sent = await new Promise(resolve => client.send('hello world', 6, 5, 45003, '127.0.0.1', (error, bytes) => resolve([error, bytes])));
    await new Promise(resolve => setTimeout(resolve, 15));
    const remote = client.remoteAddress();
    client.disconnect();
    server.close();
    client.close();
    return { received, sent: [sent[0], sent[1]], remote };
  })()`);
  assert.deepEqual(result.sent, [null, 5], 'the callback reports the byte count');
  assert.deepEqual(result.received, [['world', 5]], 'offset and length select the slice');
  assert.deepEqual(result.remote, { address: '127.0.0.1', family: 'IPv4', port: 45003 });
});

test('repl evaluates expressions and keeps declarations between lines', async () => {
  const run = lines => evaluate(`new Promise(resolve => {
    const repl = require('repl');
    const { PassThrough } = require('stream');
    const written = [];
    const output = { write: text => { written.push(String(text)); return true; } };
    const input = new PassThrough();
    const server = repl.start({ input, output, terminal: false, prompt: '> ' });
    server.once('exit', () => resolve(written.filter(line => line !== '> ' && line !== '... ').map(line => line.trim())));
    ${JSON.stringify(lines)}.forEach(line => input.write(line + String.fromCharCode(10)));
  })`);

  // A declaration completes with undefined, so it prints nothing (as in node).
  assert.deepEqual(await run(['1 + 2', 'let total = 21 * 2', 'total', '.exit']), ['3', '42']);
  // A declaration prints nothing, then the function is callable: eval() would
  // otherwise scope the declaration to itself and lose it.
  assert.deepEqual(await run(['function add(a, b) {', '  return a + b;', '}', 'add(2, 3)', '.exit']), ['5']);
  assert.deepEqual(await run(['const greet = (name) => `hi ${name}`', 'greet("dev")', '.exit']), ["'hi dev'"]);
  const withError = await run(['({ a: 1 }).a', 'nope()', '1 + 1', '.exit']);
  assert.equal(withError[0], '1');
  assert.match(withError[1], /^ReferenceError: nope is not defined/);
  assert.equal(withError[2], '2', 'an error does not end the session');
});

test('repl treats incomplete input as recoverable', async () => {
  const verdicts = await evaluate(`(() => {
    const { isValidSyntax } = require('repl');
    return ['1 + 2', 'function f() {', '"abc', 'a(', '}', 'if (true) {', 'x = [1, 2'].map(source => [source, isValidSyntax(source)]);
  })()`);
  assert.deepEqual(verdicts, [
    ['1 + 2', true],
    ['function f() {', false],
    ['"abc', false],
    ['a(', false],
    ['}', true],
    ['if (true) {', false],
    ['x = [1, 2', false],
  ]);
});

test('repl commands, context and writer match the documented API', async () => {
  const result = await evaluate(`new Promise(resolve => {
    const repl = require('repl');
    const { PassThrough } = require('stream');
    const server = repl.start({ input: new PassThrough(), output: { write: () => true }, terminal: false });
    server.defineCommand('ping', { help: 'ping it', action: () => { server.sawPing = true; } });
    server.context.shared = 7;
    server.eval('shared * 2', server.context, 'repl', (error, value) => {
      resolve({
        value,
        error,
        commands: Object.keys(server.commands).sort(),
        writer: repl.writer({ a: 1 }),
        useGlobal: typeof server.useGlobal,
        contextKeys: Object.keys(server.context).sort(),
      });
    });
  })`);
  assert.equal(result.value, 14);
  assert.equal(result.error, null);
  assert.deepEqual([...result.commands], ['clear', 'exit', 'help', 'load', 'ping']);
  assert.equal(result.writer, '{ a: 1 }');
  assert.equal(result.useGlobal, 'boolean');
  assert.ok(result.contextKeys.includes('require'), 'the context has require');
  assert.ok(result.contextKeys.includes('__filename'), 'the context has __filename');
});

test('repl start() defaults to the terminal and exposes REPL_MODE symbols', async () => {
  const result = await evaluate(`(() => {
    const repl = require('repl');
    const { PassThrough } = require('stream');
    const output = [];
    const input = new PassThrough();
    const server = repl.start({ input, output: { write: text => output.push(String(text)) }, terminal: false });
    const prompt = output.at(-1);
    const answers = [];
    server.question('name? ', answer => answers.push(answer));
    const question = output.at(-1);
    server.once('close', () => {});
    server.close();
    return { prompt, question, modeSloppy: typeof repl.REPL_MODE_SLOPPY, strict: String(repl.REPL_MODE_STRICT), recoverable: typeof repl.Recoverable, libs: repl._builtinLibs.length > 20 };
  })()`);
  assert.equal(result.prompt, '> ', 'the default prompt is printed');
  assert.equal(result.question, 'name? ', 'question() writes its query');
  assert.equal(result.modeSloppy, 'symbol');
  assert.match(result.strict, /Symbol\(repl-strict\)/);
  assert.equal(result.recoverable, 'function');
  assert.equal(result.libs, true);
});

test('trace_events tracks enabled categories and validates its options', async () => {
  const result = await evaluate(`(() => {
    const tracing = require('trace_events');
    const before = tracing.getEnabledCategories();
    const created = tracing.createTracing({ categories: ['node.async_hooks', 'v8.execute'] });
    created.enable();
    const enabled = tracing.getEnabledCategories();
    const isEnabled = created.enabled;
    const categories = created.categories;
    created.disable();
    const after = tracing.getEnabledCategories();
    const rejects = [];
    for (const options of [undefined, {}, { categories: 'x' }, { categories: [1, 2] }]) {
      try { tracing.createTracing(options); rejects.push([String(options), 'ok']); }
      catch (error) { rejects.push([String(options), error.code]); }
    }
    return { before, enabled, isEnabled, categories, after, rejects };
  })()`);
  assert.equal(result.before, undefined);
  assert.equal(result.enabled, 'node.async_hooks,v8.execute');
  assert.equal(result.isEnabled, true);
  assert.deepEqual([...result.categories], ['node.async_hooks', 'v8.execute']);
  assert.equal(result.after, undefined, 'disable clears the category');
  assert.deepEqual(result.rejects, [
    ['undefined', 'ERR_INVALID_ARG_TYPE'],
    ['[object Object]', 'ERR_INVALID_ARG_TYPE'],
    ['[object Object]', 'ERR_INVALID_ARG_TYPE'],
    ['[object Object]', 'ok'],
  ]);
});

test('wasi runs a preview1 module against the virtual filesystem', async () => {
  const result = await evaluate(`(async () => {
    const fs = require('fs');
    fs.mkdirSync('/sandbox', { recursive: true });
    fs.writeFileSync('/sandbox/data.txt', 'hello wasi');
    const { WASI } = require('wasi');
    const wasi = new WASI({ version: 'preview1', args: ['app', '--flag'], env: { NODE_ENV: 'test' }, preopens: { '/sandbox': '/sandbox' } });
    const imports = wasi.getImportObject().wasi_snapshot_preview1;
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    const bytes = () => new Uint8Array(memory.buffer);
    const read = pointer => { let end = pointer; while (bytes()[end]) end += 1; return new TextDecoder().decode(bytes().subarray(pointer, end)); };
    const instance = { exports: { memory } };
    wasi.initialize(instance);
    const out = {};
    imports.args_sizes_get(0, 4);
    imports.args_get(8, 64);
    out.args = Array.from({ length: view.getUint32(0, true) }, (_, index) => read(view.getUint32(8 + index * 4, true)));
    imports.environ_sizes_get(16, 20);
    imports.environ_get(24, 128);
    out.env = Array.from({ length: view.getUint32(16, true) }, (_, index) => read(view.getUint32(24 + index * 4, true)));
    imports.fd_prestat_get(3, 300);
    out.preopen = view.getUint32(304, true);
    const path = Buffer.from('data.txt');
    bytes().set(path, 400);
    out.openRc = imports.path_open(3, 0, 400, path.length, 0, 1n, 0n, 0, 420);
    const fd = view.getUint32(420, true);
    view.setUint32(440, 500, true);
    view.setUint32(444, 10, true);
    out.readRc = imports.fd_read(fd, 440, 1, 460);
    out.readBytes = view.getUint32(460, true);
    out.contents = new TextDecoder().decode(bytes().subarray(500, 500 + out.readBytes));
    out.statSize = (imports.fd_filestat_get(fd, 600), Number(view.getBigUint64(600 + 32, true)));
    out.seek = (imports.fd_seek(fd, 6n, 0, 700), Number(view.getBigUint64(700, true)));
    out.close = imports.fd_close(fd);
    out.closedAgain = imports.fd_close(fd);
    const escape = Buffer.from('../etc/passwd');
    bytes().set(escape, 800);
    out.escape = imports.path_open(3, 0, 800, escape.length, 0, 1n, 0n, 0, 820);
    out.missing = imports.path_open(3, 0, 401, 0, 0, 0n, 0n, 0, 840);
    out.socket = imports.sock_accept(0, 0);
    out.random = (imports.random_get(900, 8), bytes().subarray(900, 908).some(byte => byte !== 0));
    out.clock = (imports.clock_time_get(0, 1, 920), Number(view.getBigUint64(920, true)) > 0);
    return out;
  })()`);
  assert.deepEqual(result.args, ['app', '--flag']);
  assert.deepEqual(result.env, ['NODE_ENV=test']);
  assert.equal(result.preopen, 8, 'the preopen path length is reported');
  assert.equal(result.openRc, 0);
  assert.equal(result.readRc, 0);
  assert.equal(result.contents, 'hello wasi');
  assert.equal(result.statSize, 10);
  assert.equal(result.seek, 6);
  assert.equal(result.close, 0);
  assert.equal(result.closedAgain, 8, 'EBADF after close');
  assert.equal(result.escape, 76, 'ENOTCAPABLE outside the preopen');
  assert.equal(result.socket, 52, 'ENOSYS: the host does not implement sockets');
  assert.equal(result.random, true);
  assert.equal(result.clock, true);
});

test('wasi validates its options and instance before running', async () => {
  const result = await evaluate(`(() => {
    const { WASI } = require('wasi');
    const collected = [];
    for (const run of [
      () => new WASI(),
      () => new WASI({ version: 'preview2' }),
      () => new WASI({ version: 'preview1' }).start({}),
      () => new WASI({ version: 'preview1' }).start({ exports: {} }),
    ]) {
      try { run(); collected.push('ok'); } catch (error) { collected.push(error.code || error.name); }
    }
    const wasi = new WASI({ version: 'preview1' });
    collected.push(typeof wasi.getImportObject().wasi_snapshot_preview1.fd_write);
    return collected;
  })()`);
  assert.deepEqual([...result], ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_TYPE', 'function']);
});

test('repl and dgram do not leak handles into the shell', async () => {
  const result = await evaluate(`(() => {
    const sockets = require('dgram');
    const socket = sockets.createSocket('udp4');
    socket.bind(45010);
    const closed = socket.close();
    return [closed === socket, socket._closed, require('repl')._builtinLibs.includes('dgram')];
  })()`);
  assert.deepEqual([...result], [true, true, true]);
});
