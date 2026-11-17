import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, initToolchain } from './helpers/runtime.mjs';

/* Node's `wasi` module, served by the Beownir WASI host inside the runtime. The checks live in
 * test/fixtures-wasi/wasi-check.js and run in the runtime, so they exercise the same code the IDE runs. */

const here = path.dirname(fileURLToPath(import.meta.url));
const rt = await initToolchain(loadRuntime());
rt.sandbox.__check = fs.readFileSync(path.join(here, 'fixtures-wasi', 'wasi-check.js'), 'utf8');
rt.sandbox.__quickjs = fs.readFileSync(path.join(here, 'fixtures-wasi', 'quickjs.wasm'));
rt.evaluate(`(() => {
  const F = __internal.getFS();
  const at = Date.now();
  for (const dir of ['/project', '/project/wasi-check']) if (!F[dir]) F[dir] = { d: true, m: at };
  F['/project/wasi-check.js'] = { c: __check, m: at };
  F['/project/wasi-check/quickjs.wasm'] = { c: Buffer.from(__quickjs), m: at };
})()`);
const check = name => JSON.parse(rt.evaluate(`CORE.module.createRequire('/project/index.js')('/project/wasi-check.js').${name}()`));

test('require("wasi") exposes Node\'s WASI class', () => {
  assert.equal(rt.evaluate(`typeof CORE.module.createRequire('/project/index.js')('wasi').WASI`), 'function');
});

test('file system: create, write, read back, seek, stat, list, rename and delete through WASI calls', () => {
  const r = check('fileSystem');
  assert.equal(r.open, 0);
  assert.equal(r.write, 0);
  assert.equal(r.written, 11);
  assert.equal(r.close, 0);
  assert.equal(r.reopen, 0);
  assert.equal(r.read, 0);
  assert.equal(r.readText, 'hello wasi!');
  assert.equal(r.seek, 0);
  assert.equal(r.seekTo, 6);
  assert.equal(r.tell, 0);
  assert.equal(r.close2, 0);
  assert.equal(r.stat, 0);
  assert.equal(r.size, 11);
  assert.deepEqual(r.listed.sort(), ['hello.txt', 'sub'], 'the directory lists its files and subdirectories');
  assert.equal(r.unlink, 0);
  assert.equal(r.existsAfterUnlink, false);
});

test('errors use WASI errno values and never escape the preopened directory', () => {
  const r = check('fileSystem');
  assert.equal(r.missing, 44, 'ENOENT');
  assert.equal(r.escape, 76, 'ENOTCAPABLE');
  assert.equal(r.exclusive, 20, 'EEXIST');
  assert.equal(r.mkdir, 0);
  assert.equal(r.mkdirAgain, 20, 'EEXIST');
  assert.equal(r.badFd, 8, 'EBADF');
  assert.equal(r.stdout, 0);
});

test('stdout writes reach the runtime process output', () => {
  const r = check('fileSystem');
  assert.equal(r.printedToStdout, 'hello wasi!');
});

test('arguments, environment, clock and random bytes come from the host', () => {
  const r = check('environment');
  assert.equal(r.args, 0);
  assert.equal(r.argCount, 2);
  assert.equal(r.argBytes, 'prog'.length + 1 + 'one'.length + 1);
  assert.equal(r.env, 0);
  assert.equal(r.envCount, 2);
  assert.equal(r.clock, 0);
  assert.equal(r.clockPositive, true);
  assert.equal(r.random, 0);
});

test('proc_exit ends the program and start() returns its exit code', () => {
  const r = check('environment');
  assert.equal(r.exit, undefined);
  assert.equal(r.startReturned, 7);
});

test('QuickJS-NG, a real WebAssembly engine, runs on this WASI host inside the runtime', () => {
  const r = check('quickjs');
  assert.match(r.version, /^\d{4}-\d{2}-\d{2}|^\d+\.\d+/, 'QuickJS reports its version through the host');
});

test('positional reads and writes, size changes, allocation, renumbering and advice', () => {
  const r = check('positionalAndSize');
  assert.equal(r.open, 0);
  assert.equal(r.pwrite, 0);
  assert.equal(r.pwritten, 8);
  assert.equal(r.preadRc, 0);
  assert.equal(r.preadBytes, 4);
  assert.equal(r.preadText, '\u0000\u0000AB', 'bytes 2..5: the file is four zeros then ABCDEFGH, so the read starts with two zeros');
  assert.equal(r.tellAfterPositional, 0, 'positional calls leave the file position alone');
  assert.equal(r.allocate, 0);
  assert.equal(r.sizeAfterAllocate, 16);
  assert.equal(r.setSize, 0);
  assert.equal(r.sizeAfterTruncate, 3);
  assert.equal(r.advise, 0);
  assert.equal(r.renumber, 0);
  assert.equal(r.oldFdGone, 8, 'the old descriptor is gone after renumbering');
  assert.equal(r.newFdWorks, 0);
  assert.equal(r.reserved, 52, 'sockets stay ENOSYS');
});
