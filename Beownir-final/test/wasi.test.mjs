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
// Minimal WASI module whose _start calls proc_exit(7).
rt.sandbox.__childExitWasm = Uint8Array.from(Buffer.from('0061736d0100000001080260017f0060000002240116776173695f736e617073686f745f70726576696577310970726f635f657869740000030201010503010001071302066d656d6f72790200065f737461727400010a08010600410710000b', 'hex'));
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

test('a parent runs a WASI command module and receives proc_exit status', async () => {
  const result = await rt.evaluate(`CORE.module.createRequire('/project/index.js')('wasi').WASI.runChild(__childExitWasm, {version:'preview1'})`);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.outputLimitExceeded, false);
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

test('poll_oneoff handles FD_WRITE, FD_READ, BADF, CLOCK timers, and 0-subscription EINVAL', () => {
  const r = JSON.parse(rt.evaluate(`(() => {
    const req = CORE.module.createRequire('/project/index.js');
    const fs = req('fs');
    const { WASI } = req('wasi');
    fs.mkdirSync('/project/wasi-poll', { recursive: true });
    fs.writeFileSync('/project/wasi-poll/note.txt', 'hello-wasi');
    const instance = new WASI({ version: 'preview1', preopens: { '/work': '/project/wasi-poll' } });
    const memory = new WebAssembly.Memory({ initial: 1 });
    instance.initialize({ exports: { memory } });
    const imp = instance.wasiImport;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);

    bytes.set(Buffer.from('note.txt'), 100);
    const openRc = imp.path_open(3, 0, 100, 8, 0, 0n, 0n, 0, 140);
    const fileFd = view.getUint32(140, true);

    bytes.fill(0, 200, 400);
    view.setBigUint64(200, 101n, true);
    view.setUint8(208, 1);
    view.setInt32(216, fileFd, true);
    view.setBigUint64(248, 202n, true);
    view.setUint8(256, 2);
    view.setInt32(264, 1, true);
    const fdPollRc = imp.poll_oneoff(200, 500, 2, 600);
    const fdPollCount = view.getUint32(600, true);
    const ev0User = Number(view.getBigUint64(500, true));
    const ev0Err = view.getUint16(508, true);
    const ev0Type = view.getUint8(510);
    const ev0Bytes = Number(view.getBigUint64(516, true));
    const ev1User = Number(view.getBigUint64(532, true));
    const ev1Type = view.getUint8(542);
    const ev1Bytes = Number(view.getBigUint64(548, true));

    bytes.fill(0, 200, 300);
    view.setBigUint64(200, 303n, true);
    view.setUint8(208, 1);
    view.setInt32(216, 999, true);
    const badfPollRc = imp.poll_oneoff(200, 500, 1, 600);
    const badfPollCount = view.getUint32(600, true);
    const badfUser = Number(view.getBigUint64(500, true));
    const badfErr = view.getUint16(508, true);

    bytes.fill(0, 200, 300);
    view.setBigUint64(200, 404n, true);
    view.setUint8(208, 0);
    view.setUint32(216, 1, true);
    view.setBigUint64(224, 12000000n, true);
    const t0 = performance.now();
    const clkRc = imp.poll_oneoff(200, 500, 1, 600);
    const dt = performance.now() - t0;
    const clkCount = view.getUint32(600, true);
    const clkUser = Number(view.getBigUint64(500, true));
    const clkType = view.getUint8(510);

    const invalRc = imp.poll_oneoff(200, 500, 0, 600);
    imp.fd_close(fileFd);
    return JSON.stringify({ openRc, fdPollRc, fdPollCount, ev0User, ev0Err, ev0Type, ev0Bytes, ev1User, ev1Type, ev1Bytes, badfPollRc, badfPollCount, badfUser, badfErr, clkRc, dt, clkCount, clkUser, clkType, invalRc });
  })()`));

  assert.equal(r.openRc, 0);
  assert.equal(r.fdPollRc, 0);
  assert.equal(r.fdPollCount, 2);
  assert.equal(r.ev0User, 101);
  assert.equal(r.ev0Err, 0);
  assert.equal(r.ev0Type, 1);
  assert.equal(r.ev0Bytes, 10);
  assert.equal(r.ev1User, 202);
  assert.equal(r.ev1Type, 2);
  assert.equal(r.ev1Bytes, 65536);
  assert.equal(r.badfPollRc, 0);
  assert.equal(r.badfPollCount, 1);
  assert.equal(r.badfUser, 303);
  assert.equal(r.badfErr, 8);
  assert.equal(r.clkRc, 0);
  assert.ok(r.dt >= 8, 'expected clock poll to wait ~12ms, waited ' + r.dt.toFixed(1) + 'ms');
  assert.equal(r.clkCount, 1);
  assert.equal(r.clkUser, 404);
  assert.equal(r.clkType, 0);
  assert.equal(r.invalRc, 28);
});
