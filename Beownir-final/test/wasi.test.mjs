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
  assert.equal(r.notSock, 57, 'ENOTSOCK on non-socket stdin fd 0');
});

test('virtual loopback WASI sockets support listen, accept, peek, send/recv, poll_oneoff, shutdown and external host refusal', async () => {
  const r = JSON.parse(await rt.evaluate(`(async () => {
    const req = CORE.module.createRequire('/project/index.js');
    const net = req('net');
    const { WASI } = req('wasi');
    const wasi = new WASI({ version: 'preview1' });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.initialize({ exports: { memory } });
    const imp = wasi.wasiImport;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);

    // Non-loopback host is strictly refused with ENOTCAPABLE
    let extErr = null;
    try { await wasi.openListener({ host: '8.8.8.8', port: 0 }); } catch (e) { extErr = e.code; }

    // Synchronous in-runtime socket pair exercises peek, send, recv, poll, fd_read/fd_write, shutdown, close
    const [pairA, pairB] = wasi.openSocketPair();
    const statRc = imp.fd_fdstat_get(pairA, 16);
    const fdType = view.getUint8(16);

    const msg = Buffer.from('ping-loopback');
    bytes.set(msg, 128);
    view.setUint32(64, 128, true);
    view.setUint32(68, msg.length, true);
    const sendRc = imp.sock_send(pairA, 64, 1, 0, 80);
    const sent = view.getUint32(80, true);

    // Poll pairB for readable data
    bytes.fill(0, 200, 320);
    view.setBigUint64(200, 11n, true);
    view.setUint8(208, 1);
    view.setInt32(216, pairB, true);
    const pollReadRc = imp.poll_oneoff(200, 320, 1, 400);
    const pollReadCount = view.getUint32(400, true);
    const pollReadAvail = Number(view.getBigUint64(336, true));

    // Peek without consuming
    view.setUint32(64, 512, true);
    view.setUint32(68, 32, true);
    const peekRc = imp.sock_recv(pairB, 64, 1, 1, 84, 88);
    const peekBytes = view.getUint32(84, true);
    const peekText = Buffer.from(bytes.subarray(512, 512 + peekBytes)).toString();

    // Actual recv consumes
    bytes.fill(0, 512, 544);
    const recvRc = imp.sock_recv(pairB, 64, 1, 0, 84, 88);
    const recvBytes = view.getUint32(84, true);
    const recvText = Buffer.from(bytes.subarray(512, 512 + recvBytes)).toString();

    // Now empty open socket returns EAGAIN (6)
    const emptyRc = imp.sock_recv(pairB, 64, 1, 0, 84, 88);

    // Shutdown write on A -> B sees EOF (0 bytes, rc=0), A write fails with EPIPE (64)
    const shutRc = imp.sock_shutdown(pairA, 2);
    const eofRc = imp.sock_recv(pairB, 64, 1, 0, 84, 88);
    const eofBytes = view.getUint32(84, true);
    const epipeRc = imp.sock_send(pairA, 64, 1, 0, 80);

    // Also test virtual net.createServer/net.connect loopback with openListener + sock_accept
    const listener = await wasi.openListener({ host: '127.0.0.1', port: 0 });
    const acceptEmptyRc = imp.sock_accept(listener.fd, 0, 92);

    const jsClient = net.connect({ host: '127.0.0.1', port: listener.port });
    await new Promise(resolve => jsClient.once('connect', resolve));
    jsClient.write('hello-from-net-socket');
    await new Promise(r => setTimeout(r, 10));

    // Poll listener for incoming connection
    bytes.fill(0, 200, 320);
    view.setBigUint64(200, 22n, true);
    view.setUint8(208, 1);
    view.setInt32(216, listener.fd, true);
    const pollListenRc = imp.poll_oneoff(200, 320, 1, 400);
    const pollListenNbytes = Number(view.getBigUint64(336, true));

    const acceptRc = imp.sock_accept(listener.fd, 0, 92);
    const connFd = view.getUint32(92, true);
    bytes.fill(0, 600, 664);
    view.setUint32(64, 600, true);
    view.setUint32(68, 64, true);
    const netRecvRc = imp.sock_recv(connFd, 64, 1, 0, 84, 88);
    const netRecvText = Buffer.from(bytes.subarray(600, 600 + view.getUint32(84, true))).toString();

    const reply = Buffer.from('ack-from-wasi');
    bytes.set(reply, 700);
    view.setUint32(64, 700, true);
    view.setUint32(68, reply.length, true);
    const jsGot = new Promise(resolve => jsClient.once('data', d => resolve(d.toString())));
    const netSendRc = imp.sock_send(connFd, 64, 1, 0, 80);
    const jsReply = await jsGot;

    jsClient.destroy();
    wasi.close();
    return JSON.stringify({
      extErr, statRc, fdType, sendRc, sent,
      pollReadRc, pollReadCount, pollReadAvail,
      peekRc, peekText, recvRc, recvText, emptyRc,
      shutRc, eofRc, eofBytes, epipeRc,
      acceptEmptyRc, pollListenRc, pollListenNbytes,
      acceptRc, netRecvRc, netRecvText, netSendRc, jsReply
    });
  })()`));

  assert.equal(r.extErr, 'ENOTCAPABLE');
  assert.equal(r.statRc, 0);
  assert.equal(r.fdType, 6, 'SOCKET_STREAM filetype');
  assert.equal(r.sendRc, 0);
  assert.equal(r.sent, 13);
  assert.equal(r.pollReadRc, 0);
  assert.equal(r.pollReadCount, 1);
  assert.equal(r.pollReadAvail, 13);
  assert.equal(r.peekRc, 0);
  assert.equal(r.peekText, 'ping-loopback');
  assert.equal(r.recvRc, 0);
  assert.equal(r.recvText, 'ping-loopback');
  assert.equal(r.emptyRc, 6, 'EAGAIN on open empty socket');
  assert.equal(r.shutRc, 0);
  assert.equal(r.eofRc, 0);
  assert.equal(r.eofBytes, 0);
  assert.equal(r.epipeRc, 64, 'EPIPE after SHUT_WR');
  assert.equal(r.acceptEmptyRc, 6, 'EAGAIN when listener queue is empty');
  assert.equal(r.pollListenRc, 0);
  assert.equal(r.pollListenNbytes, 1);
  assert.equal(r.acceptRc, 0);
  assert.equal(r.netRecvRc, 0);
  assert.equal(r.netRecvText, 'hello-from-net-socket');
  assert.equal(r.netSendRc, 0);
  assert.equal(r.jsReply, 'ack-from-wasi');
});

test('WASI symlink, hardlink, timestamps and stdin buffering stay inside preopen boundaries', () => {
  const r = JSON.parse(rt.evaluate(`(() => {
    const req = CORE.module.createRequire('/project/index.js');
    const fs = req('fs');
    const { WASI } = req('wasi');
    fs.rmSync('/project/wasi-extra', { recursive: true, force: true });
    fs.mkdirSync('/project/wasi-extra', { recursive: true });
    fs.writeFileSync('/project/wasi-extra/src.txt', 'alpha');
    const wasi = new WASI({ version: 'preview1', preopens: { '/work': '/project/wasi-extra' }, stdin: 'input-bytes' });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.initialize({ exports: { memory } });
    const imp = wasi.wasiImport;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    const put = (ptr, str) => { const b = Buffer.from(str); bytes.set(b, ptr); return b.length; };

    // Read stdin
    view.setUint32(64, 200, true);
    view.setUint32(68, 32, true);
    const stdinRc = imp.fd_read(0, 64, 1, 80);
    const stdinText = Buffer.from(bytes.subarray(200, 200 + view.getUint32(80, true))).toString();

    // Symlink inside preopen + readlink + escape attempt blocked
    const tLen = put(300, 'src.txt');
    const lLen = put(320, 'link.txt');
    const symRc = imp.path_symlink(300, tLen, 3, 320, lLen);
    const rlRc = imp.path_readlink(3, 320, lLen, 400, 32, 84);
    const rlTarget = Buffer.from(bytes.subarray(400, 400 + view.getUint32(84, true))).toString();

    const absLen = put(350, '/etc/passwd');
    const escLen = put(370, 'bad.txt');
    const symEscRc = imp.path_symlink(350, absLen, 3, 370, escLen);

    // Hard link + timestamp update
    const hLen = put(380, 'hard.txt');
    const linkRc = imp.path_link(3, 0, 300, tLen, 3, 380, hLen);
    const tsNs = 1700000000000n * 1000000n;
    const timeRc = imp.path_filestat_set_times(3, 0, 300, tLen, tsNs, tsNs, 1 | 4);
    imp.path_filestat_get(3, 0, 300, tLen, 500);
    const mtimeNs = Number(view.getBigUint64(500 + 48, true));

    wasi.close();
    return JSON.stringify({ stdinRc, stdinText, symRc, rlRc, rlTarget, symEscRc, linkRc, timeRc, mtimeNs });
  })()`));

  assert.equal(r.stdinRc, 0);
  assert.equal(r.stdinText, 'input-bytes');
  assert.equal(r.symRc, 0);
  assert.equal(r.rlRc, 0);
  assert.equal(r.rlTarget, 'src.txt');
  assert.equal(r.symEscRc, 76, 'ENOTCAPABLE for absolute symlink target');
  assert.equal(r.linkRc, 0);
  assert.equal(r.timeRc, 0);
  assert.equal(r.mtimeNs, 1700000000000000000);
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
